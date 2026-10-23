package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// Client is one running agent process.
//
// Reads happen on one goroutine and are delivered on Messages in order. Calls are safe from any
// goroutine; a call blocks until its response, the context ends, or the process exits.
type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	writeM sync.Mutex
	nextID atomic.Int64

	pendingM sync.Mutex
	pending  map[string]pendingCall
	exited   bool

	messages chan any
	stderr   *tailBuffer
	done     chan struct{}
	trace    io.Writer // every frame both ways, when ARCHYMEDES_ACP_TRACE names a file
	traceM   sync.Mutex
}

// Start launches argv (for example `friday acp --free`) in dir and performs the handshake.
func Start(ctx context.Context, argv []string, dir string, env []string) (*Client, error) {
	if len(argv) == 0 {
		return nil, errors.New("no agent command")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	c := newClient(stdin, stdout)
	if path := os.Getenv("ARCHYMEDES_ACP_TRACE"); path != "" {
		if file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			c.trace = file
		}
	}
	cmd.Stderr = c.stderr
	c.cmd = cmd
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting agent %q: %w", argv[0], err)
	}
	go func() {
		// Wait closes stdout, so it must come after the reader has drained it, or the agent's last
		// frames (often the final response) would be lost.
		<-c.done
		c.finish(cmd.Wait())
	}()
	if err := c.initialize(ctx); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// Connect performs the handshake with an agent already running behind stdin and stdout: the Go
// engine in this process, over pipes. Close ends stdin; Exited arrives when stdout ends.
func Connect(ctx context.Context, stdin io.WriteCloser, stdout io.Reader) (*Client, error) {
	c := newClient(stdin, stdout)
	go func() {
		<-c.done
		c.finish(nil)
	}()
	if err := c.initialize(ctx); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// newClient wires a client to raw streams; Start adds the process. Separate so tests can use pipes.
func newClient(stdin io.WriteCloser, stdout io.Reader) *Client {
	c := &Client{stdin: stdin, pending: map[string]pendingCall{}, messages: make(chan any, 256), stderr: &tailBuffer{max: 16 << 10}, done: make(chan struct{})}
	go c.read(stdout)
	return c
}

// Messages delivers TextChunk, AgentEvent, PermissionRequest, QuestionRequest and finally Exited, then closes.
func (c *Client) Messages() <-chan any { return c.messages }

func (c *Client) initialize(ctx context.Context) error {
	var result struct {
		ProtocolVersion int `json:"protocolVersion"`
	}
	params := map[string]any{
		"protocolVersion":    ProtocolVersion,
		"clientCapabilities": map[string]any{"_meta": map[string]any{"archymedes": map[string]any{"events": true, "questions": true}}},
	}
	if err := c.call(ctx, "initialize", params, &result); err != nil {
		return fmt.Errorf("agent handshake: %w", err)
	}
	if result.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("agent speaks ACP %d, this client speaks %d", result.ProtocolVersion, ProtocolVersion)
	}
	return nil
}

// NewSession starts a session in cwd, or resumes resumeID when it is not empty.
func (c *Client) NewSession(ctx context.Context, cwd, resumeID string) (Session, error) {
	var result struct {
		SessionID string `json:"sessionId"`
		Meta      struct {
			Archymedes SessionInfo `json:"archymedes"`
		} `json:"_meta"`
	}
	method, params := "session/new", map[string]any{"cwd": cwd, "mcpServers": []any{}}
	if resumeID != "" {
		method, params["sessionId"] = "session/load", resumeID
	}
	if err := c.call(ctx, method, params, &result); err != nil {
		return Session{}, err
	}
	// session/load answers without a sessionId; the extension says which session "latest" was.
	id := firstOf(result.SessionID, result.Meta.Archymedes.SessionID, resumeID)
	return Session{ID: id, Info: result.Meta.Archymedes}, nil
}

// Prompt runs one turn and returns ACP's stop reason. Events arrive on Messages meanwhile.
func (c *Client) Prompt(ctx context.Context, sessionID, text string) (string, error) {
	var result struct {
		StopReason string `json:"stopReason"`
	}
	params := map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": text}}}
	err := c.call(ctx, "session/prompt", params, &result)
	return result.StopReason, err
}

// Cancel asks the running turn to stop; the pending Prompt then returns "cancelled".
func (c *Client) Cancel(sessionID string) error {
	return c.write(frame{JSONRPC: "2.0", Method: "session/cancel", Params: mustJSON(map[string]any{"sessionId": sessionID})})
}

// SetMode rebuilds the session under another capability set, keeping its transcript.
func (c *Client) SetMode(ctx context.Context, sessionID, mode string) error {
	return c.call(ctx, "session/set_mode", map[string]any{"sessionId": sessionID, "modeId": mode}, nil)
}

// Steer hands text to the turn in progress; false when no turn can take it (send it as a turn).
func (c *Client) Steer(ctx context.Context, sessionID, text string) (bool, error) {
	var result struct {
		Accepted bool `json:"accepted"`
	}
	err := c.call(ctx, "_archymedes/session/steer", map[string]any{"sessionId": sessionID, "text": text}, &result)
	return result.Accepted, err
}

// Close ends stdin, which the agent reads as the end of the connection, and waits for it to exit.
func (c *Client) Close() {
	_ = c.stdin.Close()
	<-c.done
}

// CallRaw is any request, its result as raw JSON: how one agent forwards a method to another.
func (c *Client) CallRaw(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.call(ctx, method, params, &out)
	return out, err
}

func (c *Client) call(ctx context.Context, method string, params any, out any) error {
	id := strconv.FormatInt(c.nextID.Add(1), 10)
	reply := make(chan frame, 1)
	c.pendingM.Lock()
	if c.exited {
		c.pendingM.Unlock()
		return errors.New("agent is not running")
	}
	c.pending[id] = pendingCall{reply: reply, method: method}
	c.pendingM.Unlock()
	defer func() { c.pendingM.Lock(); delete(c.pending, id); c.pendingM.Unlock() }()

	if err := c.write(frame{JSONRPC: "2.0", ID: json.RawMessage(id), Method: method, Params: mustJSON(params)}); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case f, ok := <-reply:
		if !ok {
			return fmt.Errorf("agent exited during %s%s", method, c.stderrHint())
		}
		if f.Error != nil {
			return f.Error
		}
		if out != nil && len(f.Result) > 0 {
			return json.Unmarshal(f.Result, out)
		}
		return nil
	}
}

func (c *Client) write(f frame) error {
	line, err := json.Marshal(f)
	if err != nil {
		return err
	}
	c.traced("->", line)
	c.writeM.Lock()
	defer c.writeM.Unlock()
	_, err = c.stdin.Write(append(line, '\n'))
	return err
}

func (c *Client) read(stdout io.Reader) {
	defer close(c.done)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 64<<20) // one large tool result is one line
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		c.traced("<-", []byte(line))
		var f frame
		if json.Unmarshal([]byte(line), &f) != nil {
			continue // the agent writes diagnostics to stderr; an unparseable line is not ours to act on
		}
		c.dispatch(f)
	}
}

func (c *Client) dispatch(f frame) {
	switch {
	case f.Method == "" && len(f.ID) > 0: // a response to one of our calls
		c.pendingM.Lock()
		call, ok := c.pending[normalizeID(f.ID)]
		c.pendingM.Unlock()
		if !ok {
			return
		}
		if call.method == "session/prompt" && f.Error == nil {
			// The end of a turn goes into the same stream as its events, after every one of them:
			// a caller reading the stream can never see the turn end before its last words.
			var result struct {
				StopReason string `json:"stopReason"`
			}
			_ = json.Unmarshal(f.Result, &result)
			c.messages <- TurnEnded{StopReason: result.StopReason}
		}
		call.reply <- f
	case f.Method == "session/request_permission" && len(f.ID) > 0:
		c.messages <- c.permissionRequest(f)
	case f.Method == AskMethod && len(f.ID) > 0:
		c.messages <- c.questionRequest(f)
	case f.Method == "session/update":
		if chunk, ok := textChunk(f.Params); ok {
			c.messages <- chunk
		}
	case f.Method == EventMethod:
		var params struct {
			Event Event `json:"event"`
		}
		if json.Unmarshal(f.Params, &params) == nil {
			c.messages <- AgentEvent{Event: params.Event}
		}
	case len(f.ID) > 0: // a request we do not implement: say so rather than leave the agent waiting
		_ = c.write(frame{JSONRPC: "2.0", ID: f.ID, Error: &rpcError{Code: -32601, Message: "Method not found: " + f.Method}})
	}
}

func (c *Client) permissionRequest(f frame) PermissionRequest {
	var params struct {
		ToolCall ToolCallRef        `json:"toolCall"`
		Options  []PermissionOption `json:"options"`
	}
	_ = json.Unmarshal(f.Params, &params)
	var once sync.Once
	id := f.ID
	return PermissionRequest{ToolCall: params.ToolCall, Options: params.Options, answer: func(optionID string) {
		once.Do(func() {
			outcome := map[string]any{"outcome": "cancelled"}
			if optionID != "" {
				outcome = map[string]any{"outcome": "selected", "selectedOptionId": optionID}
			}
			_ = c.write(frame{JSONRPC: "2.0", ID: id, Result: mustJSON(outcome)})
		})
	}}
}

func (c *Client) questionRequest(f frame) QuestionRequest {
	var params struct {
		ToolCallID  string   `json:"toolCallId"`
		Question    string   `json:"question"`
		Options     []string `json:"options"`
		MultiSelect bool     `json:"multiSelect"`
	}
	_ = json.Unmarshal(f.Params, &params)
	var once sync.Once
	id := f.ID
	return QuestionRequest{ToolCallID: params.ToolCallID, Question: params.Question, Options: params.Options, MultiSelect: params.MultiSelect, answer: func(text string) {
		once.Do(func() {
			result := map[string]any{"dismissed": true}
			if strings.TrimSpace(text) != "" {
				result = map[string]any{"answer": text}
			}
			_ = c.write(frame{JSONRPC: "2.0", ID: id, Result: mustJSON(result)})
		})
	}}
}

func firstOf(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// textChunk extracts assistant or replayed user text as TextChunk or UserChunk; tool updates are
// ignored because the extension carries them richer.
func textChunk(params json.RawMessage) (any, bool) {
	var value struct {
		Update struct {
			SessionUpdate string `json:"sessionUpdate"`
			Content       struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"update"`
	}
	if json.Unmarshal(params, &value) != nil || value.Update.Content.Type != "text" {
		return nil, false
	}
	switch value.Update.SessionUpdate {
	case "agent_message_chunk":
		return TextChunk{Text: value.Update.Content.Text}, true
	case "user_message_chunk":
		return UserChunk{Text: value.Update.Content.Text}, true
	}
	return nil, false
}

func (c *Client) finish(err error) {
	c.pendingM.Lock()
	c.exited = true
	for id, call := range c.pending {
		close(call.reply)
		delete(c.pending, id)
	}
	c.pendingM.Unlock()
	c.messages <- Exited{Err: err, Stderr: c.stderr.String()}
	close(c.messages)
}

func (c *Client) stderrHint() string {
	tail := strings.TrimSpace(c.stderr.String())
	if tail == "" {
		return ""
	}
	lines := strings.Split(tail, "\n")
	return ": " + lines[len(lines)-1]
}

func (c *Client) traced(direction string, line []byte) {
	if c.trace == nil {
		return
	}
	c.traceM.Lock()
	defer c.traceM.Unlock()
	fmt.Fprintf(c.trace, "%s %s\n", direction, line)
}

// normalizeID makes `"7"` and `7` the same key: we send numbers, an agent may echo either.
func normalizeID(raw json.RawMessage) string {
	return strings.Trim(string(raw), `"`)
}

func mustJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err) // only ever called on maps of plain values built in this file
	}
	return data
}

type pendingCall struct {
	reply  chan frame
	method string
}

// tailBuffer keeps the last max bytes of the agent's stderr, for error messages.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.max; over > 0 {
		t.buf = t.buf[over:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// SetupStatus asks whether a provider is usable, and which could be set up with one key.
func (c *Client) SetupStatus(ctx context.Context) (SetupStatus, error) {
	var status SetupStatus
	err := c.call(ctx, "_archymedes/setup/status", map[string]any{}, &status)
	return status, err
}

// SaveSetup checks and saves a key; the next NewSession uses it.
func (c *Client) SaveSetup(ctx context.Context, provider, key string) (SetupResult, error) {
	var result SetupResult
	err := c.call(ctx, "_archymedes/setup/save", map[string]any{"provider": provider, "key": key}, &result)
	return result, err
}

// Providers lists every provider: usable or not, what it still needs, and the model it would use.
func (c *Client) Providers(ctx context.Context) ([]ProviderOverview, error) {
	var out struct {
		Providers []ProviderOverview `json:"providers"`
	}
	err := c.call(ctx, "_archymedes/providers", map[string]any{}, &out)
	return out.Providers, err
}

// ConnectProvider checks the values against the provider (by listing its models), saves them, and
// returns the models. An empty secret keeps the saved one; an empty URL goes back to the default.
func (c *Client) ConnectProvider(ctx context.Context, provider string, values map[string]string) (ConnectResult, error) {
	var result ConnectResult
	err := c.call(ctx, "_archymedes/providers/connect", map[string]any{"provider": provider, "values": values}, &result)
	return result, err
}

// ProviderModels asks the provider itself for its models now; listErr is its reason when it cannot.
func (c *Client) ProviderModels(ctx context.Context, provider string) (models []string, listErr string, err error) {
	var out struct {
		Models []string `json:"models"`
		Error  string   `json:"error"`
	}
	err = c.call(ctx, "_archymedes/providers/models", map[string]any{"provider": provider}, &out)
	return out.Models, out.Error, err
}

// RememberModel saves the model picked for a provider, so the next session on it starts there.
func (c *Client) RememberModel(ctx context.Context, provider, model string) error {
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := c.call(ctx, "_archymedes/providers/remember-model", map[string]any{"provider": provider, "model": model}, &out); err != nil {
		return err
	}
	if !out.OK && out.Error != "" {
		return errors.New(out.Error)
	}
	return nil
}

// Settings reads the settings menu: every field, its section, choices and current value.
func (c *Client) Settings(ctx context.Context) (SettingsList, error) {
	var list SettingsList
	err := c.call(ctx, "_archymedes/settings/list", map[string]any{}, &list)
	return list, err
}

// SetSetting validates and saves one setting; an empty value clears it.
func (c *Client) SetSetting(ctx context.Context, key, value string) (SettingsSetResult, error) {
	var result SettingsSetResult
	err := c.call(ctx, "_archymedes/settings/set", map[string]any{"key": key, "value": value}, &result)
	return result, err
}

// Models lists what the session can switch to; refresh asks the providers rather than the cache.
func (c *Client) Models(ctx context.Context, refresh bool) (ModelList, error) {
	var list ModelList
	err := c.call(ctx, "_archymedes/models", map[string]any{"refresh": refresh}, &list)
	return list, err
}

// SetModel switches the session's model, keeping its transcript, and returns the session's new info.
func (c *Client) SetModel(ctx context.Context, sessionID, provider, model string) (SessionInfo, error) {
	var result struct {
		Meta struct {
			Archymedes SessionInfo `json:"archymedes"`
		} `json:"_meta"`
	}
	err := c.call(ctx, "_archymedes/session/set_model", map[string]any{"sessionId": sessionID, "provider": provider, "model": model}, &result)
	return result.Meta.Archymedes, err
}

// Command runs a session command (cost, diff, undo, todos) and returns its answer as data.
func (c *Client) Command(ctx context.Context, sessionID, command, argument string) (CommandResult, error) {
	var result CommandResult
	err := c.call(ctx, "_archymedes/session/command", map[string]any{"sessionId": sessionID, "command": command, "argument": argument}, &result)
	return result, err
}

// Sessions lists the stored sessions of a project, newest first.
func (c *Client) Sessions(ctx context.Context, cwd string) ([]SessionSummary, error) {
	var sessions []SessionSummary
	err := c.call(ctx, "_archymedes/sessions", map[string]any{"cwd": cwd}, &sessions)
	return sessions, err
}

// CloseSession ends a session the client no longer shows.
func (c *Client) CloseSession(ctx context.Context, sessionID string) error {
	return c.call(ctx, "session/close", map[string]any{"sessionId": sessionID}, nil)
}

// Startup runs the agent's once-per-start upkeep (the update check) and returns what it has to say.
func (c *Client) Startup(ctx context.Context) ([]string, error) {
	var result struct {
		Notices []string `json:"notices"`
	}
	err := c.call(ctx, "_archymedes/startup", map[string]any{}, &result)
	return result.Notices, err
}
