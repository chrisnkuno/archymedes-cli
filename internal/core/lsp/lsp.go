// Package lsp asks a language server what is wrong with a file Friday just changed, so the model
// hears about the error its edit made before it moves on. One server per language a session
// touches, started the first time a file of that language changes, and only if it is installed:
// gopls, typescript-language-server, pyright, rust-analyzer, clangd. Nothing is installed for it.
package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Server is how to run one language's server.
type Server struct {
	Name       string
	Command    string
	Args       []string
	Extensions []string
	LanguageID string
}

// Known are the servers Friday knows how to start, by language.
var Known = []Server{
	{Name: "gopls", Command: "gopls", Extensions: []string{".go"}, LanguageID: "go"},
	{Name: "typescript", Command: "typescript-language-server", Args: []string{"--stdio"}, Extensions: []string{".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}, LanguageID: "typescript"},
	{Name: "pyright", Command: "pyright-langserver", Args: []string{"--stdio"}, Extensions: []string{".py"}, LanguageID: "python"},
	{Name: "rust-analyzer", Command: "rust-analyzer", Extensions: []string{".rs"}, LanguageID: "rust"},
	{Name: "clangd", Command: "clangd", Extensions: []string{".c", ".h", ".cc", ".cpp", ".hpp"}, LanguageID: "cpp"},
}

// Diagnostic is one problem a server reported.
type Diagnostic struct {
	Line     int // 1-based
	Column   int // 1-based
	Severity int // 1 error, 2 warning, 3 information, 4 hint
	Message  string
	Source   string
}

// Manager is a session's language servers.
type Manager struct {
	root     string
	servers  []Server
	lookPath func(string) (string, error)
	// settle is how long to wait for a server's answer after a change.
	settle time.Duration

	mu      sync.Mutex
	clients map[string]*client
	failed  map[string]string
	closed  bool
}

// NewManager is a project's language servers, none started yet.
func NewManager(root string) *Manager {
	return &Manager{root: root, servers: Known, lookPath: exec.LookPath, settle: 8 * time.Second,
		clients: map[string]*client{}, failed: map[string]string{}}
}

// serverFor is the server for a file, if Friday knows one and it is installed.
func (m *Manager) serverFor(path string) (Server, bool) {
	ext := strings.ToLower(filepath.Ext(path))
	for _, s := range m.servers {
		for _, e := range s.Extensions {
			if e == ext {
				if _, err := m.lookPath(s.Command); err != nil {
					return Server{}, false
				}
				return s, true
			}
		}
	}
	return Server{}, false
}

// Check is what the file's server says is wrong with it now, worst first; nil when no server
// covers the file or it does not answer in time.
func (m *Manager) Check(ctx context.Context, path string) []Diagnostic {
	s, ok := m.serverFor(path)
	if !ok {
		return nil
	}
	c, err := m.client(ctx, s)
	if err != nil {
		return nil
	}
	abs := path
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(m.root, abs)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil
	}
	diags, err := c.check(ctx, abs, s.LanguageID, string(data), m.settle)
	if err != nil {
		m.mu.Lock()
		m.failed[s.Name] = err.Error()
		delete(m.clients, s.Name)
		m.mu.Unlock()
		c.close()
		return nil
	}
	sort.SliceStable(diags, func(i, j int) bool {
		if diags[i].Severity != diags[j].Severity {
			return diags[i].Severity < diags[j].Severity
		}
		return diags[i].Line < diags[j].Line
	})
	return diags
}

func (m *Manager) client(ctx context.Context, s Server) (*client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, fmt.Errorf("the session is closed")
	}
	if c := m.clients[s.Name]; c != nil {
		return c, nil
	}
	if why := m.failed[s.Name]; why != "" {
		return nil, fmt.Errorf("%s", why)
	}
	c, err := start(ctx, s, m.root)
	if err != nil {
		m.failed[s.Name] = err.Error()
		return nil, err
	}
	m.clients[s.Name] = c
	return c, nil
}

// Status is one line per server for /lsp.
func (m *Manager) Status() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var lines []string
	for _, s := range m.servers {
		state := "not installed"
		if _, err := m.lookPath(s.Command); err == nil {
			state = "installed, starts when a " + strings.Join(s.Extensions, " ") + " file changes"
		}
		if m.clients[s.Name] != nil {
			state = "running"
		}
		if why := m.failed[s.Name]; why != "" {
			state = "failed: " + why
		}
		lines = append(lines, fmt.Sprintf("%s (%s): %s", s.Name, s.Command, state))
	}
	return lines
}

// Close stops every server.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	clients := m.clients
	m.clients = map[string]*client{}
	m.mu.Unlock()
	for _, c := range clients {
		c.close()
	}
}

// quiet is how long a server's diagnostics must stay unchanged to be taken as its answer.
var quiet = 700 * time.Millisecond

// maxReported is how many problems a tool result names.
const maxReported = 12

// Report is what a tool result adds about a changed file: its errors and some warnings, or "".
func Report(path string, diags []Diagnostic) string {
	var lines []string
	errors := 0
	for _, d := range diags {
		if d.Severity > 2 || len(lines) == maxReported {
			continue
		}
		if d.Severity == 1 {
			errors++
		}
		kind := map[int]string{1: "error", 2: "warning"}[d.Severity]
		msg := strings.ReplaceAll(strings.TrimSpace(d.Message), "\n", " ")
		lines = append(lines, fmt.Sprintf("%s:%d:%d: %s: %s", filepath.Base(path), d.Line, d.Column, kind, msg))
	}
	if len(lines) == 0 {
		return ""
	}
	head := fmt.Sprintf("The language server reports %d problem(s) in %s after this change:", len(lines), filepath.Base(path))
	if errors > 0 {
		head = fmt.Sprintf("The language server reports %d error(s) in %s after this change; fix them before going on:", errors, filepath.Base(path))
	}
	return head + "\n" + strings.Join(lines, "\n")
}

// Decorate makes an editing tool tell the model what the language server finds in the file it
// changed. The tool runs as before; a successful change gets the report added to its result.
func Decorate(t *tool.Tool, m *Manager) *tool.Tool {
	run := t.Run
	wrapped := *t
	wrapped.Run = func(ctx context.Context, tc tool.Context, args tool.Args) tool.Result {
		res := run(ctx, tc, args)
		path, _ := args["path"].(string)
		if res.IsError || path == "" {
			return res
		}
		if report := Report(path, m.Check(ctx, path)); report != "" {
			res.Content += "\n\n" + report
		}
		return res
	}
	return &wrapped
}

// client is one running language server.
type client struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int
	pending map[int]chan json.RawMessage
	// versions are the documents opened, by URI, with their version.
	versions map[string]int
	// diags are the latest diagnostics per URI, and waiters who want the next ones.
	diags   map[string][]Diagnostic
	waiters map[string][]chan []Diagnostic
	done    chan struct{}
}

func start(ctx context.Context, s Server, root string) (*client, error) {
	cmd := exec.Command(s.Command, s.Args...)
	cmd.Dir = root
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("%s did not start: %w", s.Command, err)
	}
	c := &client{cmd: cmd, stdin: stdin, pending: map[int]chan json.RawMessage{}, versions: map[string]int{},
		diags: map[string][]Diagnostic{}, waiters: map[string][]chan []Diagnostic{}, done: make(chan struct{})}
	go c.read(bufio.NewReader(stdout))
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	rootURI := fileURI(root)
	_, err = c.request(ctx, "initialize", map[string]any{
		"processId": os.Getpid(), "rootUri": rootURI,
		"workspaceFolders": []any{map[string]any{"uri": rootURI, "name": filepath.Base(root)}},
		"capabilities": map[string]any{"textDocument": map[string]any{
			"publishDiagnostics": map[string]any{"relatedInformation": false},
			"synchronization":    map[string]any{"didSave": true},
		}},
	})
	if err != nil {
		c.close()
		return nil, fmt.Errorf("%s did not initialize: %w", s.Command, err)
	}
	c.notify("initialized", map[string]any{})
	return c, nil
}

// check sends the file's text and waits for the diagnostics that follow it.
func (c *client) check(ctx context.Context, path, languageID, text string, settle time.Duration) ([]Diagnostic, error) {
	uri := fileURI(path)
	wait := make(chan []Diagnostic, 1)
	c.mu.Lock()
	c.waiters[uri] = append(c.waiters[uri], wait)
	version, open := c.versions[uri]
	c.versions[uri] = version + 1
	c.mu.Unlock()
	if !open {
		c.notify("textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": languageID, "version": 1, "text": text}})
	} else {
		c.notify("textDocument/didChange", map[string]any{"textDocument": map[string]any{"uri": uri, "version": version + 1},
			"contentChanges": []any{map[string]any{"text": text}}})
		c.notify("textDocument/didSave", map[string]any{"textDocument": map[string]any{"uri": uri}, "text": text})
	}
	timer := time.NewTimer(settle)
	defer timer.Stop()
	select {
	case <-wait:
		// Servers often publish more than once for one change (an early pass, then the type
		// checker's): a short quiet spell, then the latest.
		select {
		case <-time.After(quiet):
		case <-ctx.Done():
		}
		c.mu.Lock()
		d := c.diags[uri]
		c.mu.Unlock()
		return d, nil
	case <-timer.C:
		c.mu.Lock()
		d := c.diags[uri] // nothing new in time: the last known, which may be none
		c.mu.Unlock()
		return d, nil
	case <-c.done:
		return nil, fmt.Errorf("the server stopped")
	case <-ctx.Done():
		return nil, nil
	}
}

func (c *client) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan json.RawMessage, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		return r, nil
	case <-c.done:
		return nil, fmt.Errorf("the server stopped")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *client) notify(method string, params any) {
	_ = c.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

// write sends one message with its Content-Length header, the way LSP frames them.
func (c *client) write(msg any) error {
	body, _ := json.Marshal(msg)
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err := fmt.Fprintf(c.stdin, "Content-Length: %d\r\n\r\n%s", len(body), body)
	return err
}

func (c *client) read(r *bufio.Reader) {
	defer close(c.done)
	for {
		length := 0
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimSpace(line)
			if line == "" {
				break
			}
			if v, ok := strings.CutPrefix(line, "Content-Length:"); ok {
				length, _ = strconv.Atoi(strings.TrimSpace(v))
			}
		}
		if length <= 0 || length > 64<<20 {
			return
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(r, body); err != nil {
			return
		}
		var msg struct {
			ID     *json.RawMessage `json:"id"`
			Method string           `json:"method"`
			Params json.RawMessage  `json:"params"`
			Result json.RawMessage  `json:"result"`
		}
		if json.Unmarshal(body, &msg) != nil {
			continue
		}
		switch {
		case msg.Method == "textDocument/publishDiagnostics":
			c.published(msg.Params)
		case msg.Method != "" && msg.ID != nil:
			// A request from the server (configuration, progress): answered empty, never left hanging.
			_ = c.write(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": nil})
		case msg.ID != nil:
			var id int
			if json.Unmarshal(*msg.ID, &id) == nil {
				c.mu.Lock()
				ch := c.pending[id]
				delete(c.pending, id)
				c.mu.Unlock()
				if ch != nil {
					ch <- msg.Result
				}
			}
		}
	}
}

func (c *client) published(params json.RawMessage) {
	var p struct {
		URI         string `json:"uri"`
		Diagnostics []struct {
			Range struct {
				Start struct{ Line, Character int } `json:"start"`
			} `json:"range"`
			Severity int    `json:"severity"`
			Message  string `json:"message"`
			Source   string `json:"source"`
		} `json:"diagnostics"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	var diags []Diagnostic
	for _, d := range p.Diagnostics {
		sev := d.Severity
		if sev == 0 {
			sev = 1
		}
		diags = append(diags, Diagnostic{Line: d.Range.Start.Line + 1, Column: d.Range.Start.Character + 1, Severity: sev, Message: d.Message, Source: d.Source})
	}
	c.mu.Lock()
	c.diags[p.URI] = diags
	waiters := c.waiters[p.URI]
	delete(c.waiters, p.URI)
	c.mu.Unlock()
	for _, w := range waiters {
		w <- diags
	}
}

func (c *client) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = c.request(ctx, "shutdown", nil)
	c.notify("exit", nil)
	_ = c.stdin.Close()
	select {
	case <-c.done:
	case <-time.After(2 * time.Second):
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
	}
	_ = c.cmd.Wait()
}

func fileURI(path string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
}
