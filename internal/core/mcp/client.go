package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ProtocolVersion is the MCP revision asked for; a server answering with another is accepted.
const ProtocolVersion = "2025-06-18"

// RemoteTool is a tool as a server lists it.
type RemoteTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations struct {
		ReadOnlyHint bool `json:"readOnlyHint"`
	} `json:"annotations"`
}

// CallResult is what a tool call returned: its text, and whether the server called it an error.
type CallResult struct {
	Text    string
	IsError bool
}

// transport sends one JSON-RPC request and returns its result, or sends a notification (id < 0).
type transport interface {
	roundTrip(ctx context.Context, id int64, method string, params any) (json.RawMessage, error)
	close()
}

// Client is a connection to one server.
type Client struct {
	t      transport
	nextID atomic.Int64
}

// rpcError is a JSON-RPC error from the server.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("the server said %s (code %d)", e.Message, e.Code)
}

// Connect starts or reaches the server and completes the handshake.
func Connect(ctx context.Context, s Server, environ []string) (*Client, error) {
	var t transport
	var err error
	if s.URL != "" {
		t = &httpTransport{url: s.URL, headers: s.Headers, client: &http.Client{}}
	} else {
		t, err = startStdio(s, environ)
		if err != nil {
			return nil, err
		}
	}
	c := &Client{t: t}
	init := map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "friday", "version": "1"},
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if _, err := c.call(ctx, "initialize", init); err != nil {
		t.close()
		return nil, fmt.Errorf("it did not complete the MCP handshake: %w", err)
	}
	if _, err := t.roundTrip(ctx, -1, "notifications/initialized", map[string]any{}); err != nil {
		t.close()
		return nil, err
	}
	return c, nil
}

func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return c.t.roundTrip(ctx, c.nextID.Add(1), method, params)
}

// Tools lists every tool the server offers, following its pages.
func (c *Client) Tools(ctx context.Context) ([]RemoteTool, error) {
	var all []RemoteTool
	cursor := ""
	for page := 0; page < 50; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.call(ctx, "tools/list", params)
		if err != nil {
			return nil, err
		}
		var res struct {
			Tools      []RemoteTool `json:"tools"`
			NextCursor string       `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, fmt.Errorf("its tool list could not be read: %w", err)
		}
		all = append(all, res.Tools...)
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	return all, nil
}

// Call runs one tool. Text parts are joined; other parts are named, not inlined.
func (c *Client) Call(ctx context.Context, name string, args map[string]any) (CallResult, error) {
	if args == nil {
		args = map[string]any{}
	}
	raw, err := c.call(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return CallResult{}, err
	}
	var res struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			MimeType string `json:"mimeType"`
			Resource struct {
				URI  string `json:"uri"`
				Text string `json:"text"`
			} `json:"resource"`
		} `json:"content"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		IsError           bool            `json:"isError"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return CallResult{}, fmt.Errorf("its answer could not be read: %w", err)
	}
	var parts []string
	for _, p := range res.Content {
		switch p.Type {
		case "text":
			parts = append(parts, p.Text)
		case "resource":
			parts = append(parts, strings.TrimSpace(p.Resource.URI+"\n"+p.Resource.Text))
		default:
			parts = append(parts, fmt.Sprintf("[%s %s, not shown]", p.Type, p.MimeType))
		}
	}
	if len(parts) == 0 && len(res.StructuredContent) > 0 {
		parts = append(parts, string(res.StructuredContent))
	}
	return CallResult{Text: strings.Join(parts, "\n"), IsError: res.IsError}, nil
}

// Close ends the connection, and the server's process for a stdio server.
func (c *Client) Close() { c.t.close() }

// stdioTransport is a server program speaking newline-delimited JSON-RPC on its stdin and stdout.
type stdioTransport struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser

	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[int64]chan response
	done    chan struct{}
	err     error
	stderr  bytes.Buffer
}

type response struct {
	result json.RawMessage
	err    error
}

func startStdio(s Server, environ []string) (*stdioTransport, error) {
	cmd := exec.Command(s.Command, s.Args...)
	cmd.Env = append([]string(nil), environ...)
	for k, v := range s.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	t := &stdioTransport{cmd: cmd, stdin: stdin, pending: map[int64]chan response{}, done: make(chan struct{})}
	cmd.Stderr = &limitedWriter{buf: &t.stderr, max: 4096}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("it could not be started (%s): %w", s.Command, err)
	}
	go t.read(stdout)
	return t, nil
}

func (t *stdioTransport) read(stdout io.Reader) {
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64<<10), 32<<20)
	for sc.Scan() {
		var msg struct {
			ID     *json.Number    `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
			Error  *rpcError       `json:"error"`
		}
		if json.Unmarshal(sc.Bytes(), &msg) != nil || msg.ID == nil || msg.Method != "" {
			continue // a notification or a request from the server: nothing Friday answers yet
		}
		id, err := msg.ID.Int64()
		if err != nil {
			continue
		}
		t.mu.Lock()
		ch := t.pending[id]
		delete(t.pending, id)
		t.mu.Unlock()
		if ch == nil {
			continue
		}
		if msg.Error != nil {
			ch <- response{err: msg.Error}
		} else {
			ch <- response{result: msg.Result}
		}
	}
	_ = t.cmd.Wait()
	t.mu.Lock()
	t.err = errors.New("the server stopped")
	if tail := strings.TrimSpace(t.stderr.String()); tail != "" {
		t.err = fmt.Errorf("the server stopped: %s", lastLine(tail))
	}
	for id, ch := range t.pending {
		ch <- response{err: t.err}
		delete(t.pending, id)
	}
	t.mu.Unlock()
	close(t.done)
}

func (t *stdioTransport) roundTrip(ctx context.Context, id int64, method string, params any) (json.RawMessage, error) {
	msg := map[string]any{"jsonrpc": "2.0", "method": method, "params": params}
	var ch chan response
	if id >= 0 {
		msg["id"] = id
		ch = make(chan response, 1)
		t.mu.Lock()
		if t.err != nil {
			err := t.err
			t.mu.Unlock()
			return nil, err
		}
		t.pending[id] = ch
		t.mu.Unlock()
	}
	line, _ := json.Marshal(msg)
	t.writeMu.Lock()
	_, err := t.stdin.Write(append(line, '\n'))
	t.writeMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("the server is not reading: %w", err)
	}
	if ch == nil {
		return nil, nil
	}
	select {
	case r := <-ch:
		return r.result, r.err
	case <-ctx.Done():
		t.mu.Lock()
		delete(t.pending, id)
		t.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (t *stdioTransport) close() {
	_ = t.stdin.Close()
	select {
	case <-t.done:
	case <-time.After(2 * time.Second):
		if t.cmd.Process != nil {
			_ = t.cmd.Process.Kill()
		}
		<-t.done
	}
}

// httpTransport is streamable HTTP: each message a POST, the answer JSON or a stream of events.
type httpTransport struct {
	url     string
	headers map[string]string
	client  *http.Client

	mu      sync.Mutex
	session string
}

func (t *httpTransport) roundTrip(ctx context.Context, id int64, method string, params any) (json.RawMessage, error) {
	msg := map[string]any{"jsonrpc": "2.0", "method": method, "params": params}
	if id >= 0 {
		msg["id"] = id
	}
	body, _ := json.Marshal(msg)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", ProtocolVersion)
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	t.mu.Lock()
	if t.session != "" {
		req.Header.Set("Mcp-Session-Id", t.session)
	}
	t.mu.Unlock()
	resp, err := t.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("it could not be reached: %w", err)
	}
	defer resp.Body.Close()
	if s := resp.Header.Get("Mcp-Session-Id"); s != "" {
		t.mu.Lock()
		t.session = s
		t.mu.Unlock()
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("it refused the request (%s): check the headers it needs, such as an Authorization token", resp.Status)
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("it answered %s", resp.Status)
	}
	if id < 0 {
		return nil, nil
	}
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		return readEvents(resp.Body, id)
	}
	return decode(io.LimitReader(resp.Body, 32<<20), id)
}

// readEvents reads server-sent events until the one answering id.
func readEvents(r io.Reader, id int64) (json.RawMessage, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 32<<20)
	var data strings.Builder
	for sc.Scan() {
		line := sc.Text()
		if rest, ok := strings.CutPrefix(line, "data:"); ok {
			data.WriteString(strings.TrimPrefix(rest, " "))
			continue
		}
		if line == "" && data.Len() > 0 {
			result, err := decode(strings.NewReader(data.String()), id)
			data.Reset()
			if err == nil || !errors.Is(err, errNotOurs) {
				return result, err
			}
		}
	}
	return nil, errors.New("its event stream ended without an answer")
}

var errNotOurs = errors.New("a message for another request")

func decode(r io.Reader, id int64) (json.RawMessage, error) {
	var msg struct {
		ID     *json.Number    `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *rpcError       `json:"error"`
	}
	if err := json.NewDecoder(r).Decode(&msg); err != nil {
		return nil, fmt.Errorf("its answer is not JSON-RPC: %w", err)
	}
	if msg.ID == nil || msg.ID.String() != fmt.Sprint(id) {
		return nil, errNotOurs
	}
	if msg.Error != nil {
		return nil, msg.Error
	}
	return msg.Result, nil
}

func (t *httpTransport) close() {
	t.mu.Lock()
	session := t.session
	t.mu.Unlock()
	if session == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if req, err := http.NewRequestWithContext(ctx, http.MethodDelete, t.url, nil); err == nil {
		req.Header.Set("Mcp-Session-Id", session)
		if resp, err := t.client.Do(req); err == nil {
			resp.Body.Close()
		}
	}
}

type limitedWriter struct {
	mu  sync.Mutex
	buf *bytes.Buffer
	max int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf.Write(p)
	if extra := w.buf.Len() - w.max; extra > 0 {
		w.buf.Next(extra)
	}
	return len(p), nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// Environ is the environment a stdio server starts in: Friday's own.
func Environ() []string { return os.Environ() }
