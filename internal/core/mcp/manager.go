package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Manager is one session's MCP servers: their tools as Friday tools, and their connections, made
// when a tool is first called and kept until the session closes.
type Manager struct {
	servers  []Server
	problems []string
	cacheDir string
	environ  []string

	mu      sync.Mutex
	conns   map[string]*Client
	listing map[string]bool   // a background listing has started
	listed  map[string]listed // what a listing found, this session
	failed  map[string]string // why a server could not be reached
	closed  bool
}

type listed struct {
	Tools    []RemoteTool `json:"tools"`
	ListedAt time.Time    `json:"listedAt"`
}

// NewManager reads the declared servers. cacheDir keeps each server's tool list, so a later session
// offers them without starting it ("" keeps nothing).
func NewManager(files []string, getenv func(string) string, environ []string, cacheDir string) *Manager {
	servers, problems := Load(files, getenv)
	return &Manager{servers: servers, problems: problems, cacheDir: cacheDir, environ: environ,
		conns: map[string]*Client{}, listing: map[string]bool{}, listed: map[string]listed{}, failed: map[string]string{}}
}

// Servers are the declared servers; Problems what was wrong with the files or entries skipped.
func (m *Manager) Servers() []Server  { return m.servers }
func (m *Manager) Problems() []string { return m.problems }

// Tools are every server's tools, deferred. A server listed before (cached) is not started; one
// never listed is listed in the background, and its tools join from the next turn.
func (m *Manager) Tools() []*tool.Tool {
	var out []*tool.Tool
	used := map[string]bool{}
	for _, s := range m.servers {
		remote, ok := m.known(s)
		if !ok {
			m.listInBackground(s)
			continue
		}
		for _, r := range remote {
			name := toolName(s.ID, r.Name)
			if used[name] {
				continue
			}
			used[name] = true
			out = append(out, m.wrap(s, r, name))
		}
	}
	return out
}

// known is a server's tools, from this session's listing or the cache.
func (m *Manager) known(s Server) ([]RemoteTool, bool) {
	m.mu.Lock()
	l, ok := m.listed[s.ID]
	m.mu.Unlock()
	if ok {
		return l.Tools, true
	}
	if m.cacheDir == "" {
		return nil, false
	}
	data, err := os.ReadFile(m.cacheFile(s))
	if err != nil {
		return nil, false
	}
	if json.Unmarshal(data, &l) != nil {
		return nil, false
	}
	m.mu.Lock()
	m.listed[s.ID] = l
	m.mu.Unlock()
	return l.Tools, true
}

func (m *Manager) cacheFile(s Server) string {
	sum := sha256.Sum256([]byte(s.Key()))
	return filepath.Join(m.cacheDir, hex.EncodeToString(sum[:8])+".json")
}

func (m *Manager) remember(s Server, tools []RemoteTool) {
	l := listed{Tools: tools, ListedAt: time.Now()}
	m.mu.Lock()
	m.listed[s.ID] = l
	delete(m.failed, s.ID)
	m.mu.Unlock()
	if m.cacheDir == "" {
		return
	}
	if err := os.MkdirAll(m.cacheDir, 0o700); err != nil {
		return
	}
	if data, err := json.Marshal(l); err == nil {
		tmp := m.cacheFile(s) + ".tmp"
		if os.WriteFile(tmp, data, 0o600) == nil {
			_ = os.Rename(tmp, m.cacheFile(s))
		}
	}
}

// listInBackground starts a server once to read its tools, then stops it.
func (m *Manager) listInBackground(s Server) {
	m.mu.Lock()
	if m.listing[s.ID] || m.closed {
		m.mu.Unlock()
		return
	}
	m.listing[s.ID] = true
	m.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		c, err := Connect(ctx, s, m.environ)
		if err != nil {
			m.fail(s, err)
			return
		}
		defer c.Close()
		tools, err := c.Tools(ctx)
		if err != nil {
			m.fail(s, err)
			return
		}
		m.remember(s, tools)
	}()
}

// WaitListed waits until every server has been listed or failed, or ctx ends (for tests and /mcp).
func (m *Manager) WaitListed(ctx context.Context) {
	for {
		m.mu.Lock()
		pending := 0
		for _, s := range m.servers {
			if _, ok := m.listed[s.ID]; !ok && m.failed[s.ID] == "" {
				pending++
			}
		}
		m.mu.Unlock()
		if pending == 0 || ctx.Err() != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (m *Manager) fail(s Server, err error) {
	m.mu.Lock()
	m.failed[s.ID] = err.Error()
	m.mu.Unlock()
}

// client is the server's connection, made now if there is none.
func (m *Manager) client(ctx context.Context, s Server) (*Client, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, fmt.Errorf("the session is closed")
	}
	c := m.conns[s.ID]
	m.mu.Unlock()
	if c != nil {
		return c, nil
	}
	c, err := Connect(ctx, s, m.environ)
	if err != nil {
		m.fail(s, err)
		return nil, err
	}
	m.mu.Lock()
	if existing := m.conns[s.ID]; existing != nil || m.closed {
		m.mu.Unlock()
		c.Close()
		if existing == nil {
			return nil, fmt.Errorf("the session is closed")
		}
		return existing, nil
	}
	m.conns[s.ID] = c
	m.mu.Unlock()
	// Connected anyway: refresh the cached list, so a server that gained tools offers them next turn.
	go func() {
		lctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if tools, err := c.Tools(lctx); err == nil {
			m.remember(s, tools)
		}
	}()
	return c, nil
}

func (m *Manager) drop(id string, c *Client) {
	m.mu.Lock()
	if m.conns[id] == c {
		delete(m.conns, id)
	}
	m.mu.Unlock()
	c.Close()
}

// maxResult is how much of a tool's answer reaches the model.
const maxResult = 40_000

func (m *Manager) wrap(s Server, r RemoteTool, name string) *tool.Tool {
	schema := r.InputSchema
	if schema == nil || schema["type"] != "object" {
		schema = map[string]any{"type": "object", "properties": map[string]any{}}
	}
	capability := tool.CapExternal
	if r.Annotations.ReadOnlyHint {
		capability = tool.CapResearch // a server's own claim: offered in plan mode, still asked about
	}
	description := strings.TrimSpace(r.Description)
	if len(description) > 1000 {
		description = description[:1000] + "…"
	}
	if description == "" {
		description = "No description given."
	}
	return &tool.Tool{
		Name:         name,
		Description:  description + " (MCP server " + s.ID + ")",
		Schema:       schema,
		Capability:   capability,
		Effect:       tool.EffectExternal,
		Deferred:     true,
		ReadOnlyHint: r.Annotations.ReadOnlyHint,
		Provenance:   tool.Provenance{Kind: "mcp", ProviderID: s.ID},
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			res, err := m.call(ctx, s, r.Name, args)
			if err != nil {
				return tool.Error("The MCP server " + s.ID + " could not run " + r.Name + ": " + err.Error() + ".")
			}
			text := res.Text
			if len(text) > maxResult {
				text = text[:maxResult] + "\n[… cut]"
			}
			if res.IsError {
				return tool.Error(text)
			}
			return tool.Text(text)
		},
	}
}

// call runs a tool, reconnecting once if the connection broke since the last call.
func (m *Manager) call(ctx context.Context, s Server, name string, args map[string]any) (CallResult, error) {
	for attempt := 0; ; attempt++ {
		c, err := m.client(ctx, s)
		if err != nil {
			return CallResult{}, err
		}
		res, err := c.Call(ctx, name, args)
		if err == nil || ctx.Err() != nil || attempt > 0 {
			return res, err
		}
		if _, isRPC := err.(*rpcError); isRPC {
			return res, err
		}
		m.drop(s.ID, c)
	}
}

// Status is one line per server for /mcp: running, cached, failed, or not yet listed.
func (m *Manager) Status() []string {
	var lines []string
	for _, s := range m.servers {
		m.mu.Lock()
		_, running := m.conns[s.ID]
		l, haveList := m.listed[s.ID]
		why := m.failed[s.ID]
		listing := m.listing[s.ID]
		m.mu.Unlock()
		if !haveList {
			if tools, ok := m.known(s); ok {
				l, haveList = listed{Tools: tools}, true
			}
		}
		state := "not started (its tools are known)"
		switch {
		case why != "":
			state = "could not be reached: " + why
		case running:
			state = "running"
		case !haveList && listing:
			state = "being listed"
		case !haveList:
			state = "not listed yet"
		}
		count := ""
		if haveList {
			count = fmt.Sprintf("%d tools · ", len(l.Tools))
		}
		lines = append(lines, fmt.Sprintf("%s: %s%s (%s)", s.ID, count, state, s.From))
	}
	return lines
}

// Prompt is the line per server the model sees: which servers there are and what their tools are
// called, so it knows to look; their schemas stay out until tool_search loads one.
func (m *Manager) Prompt() string {
	var lines []string
	for _, s := range m.servers {
		remote, ok := m.known(s)
		if !ok || len(remote) == 0 {
			continue
		}
		var names []string
		for i, r := range remote {
			if i == 10 {
				names = append(names, fmt.Sprintf("and %d more", len(remote)-10))
				break
			}
			names = append(names, r.Name)
		}
		lines = append(lines, fmt.Sprintf("- %s: %s", s.ID, strings.Join(names, ", ")))
	}
	if len(lines) == 0 {
		return ""
	}
	return "MCP servers, with their tools (named mcp__<server>__<tool>; not loaded until you need one: call tool_search with what you want to do, or call the tool by its full name):\n" + strings.Join(lines, "\n")
}

// Close ends every connection.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	conns := m.conns
	m.conns = map[string]*Client{}
	m.mu.Unlock()
	for _, c := range conns {
		c.Close()
	}
}

var unsafeName = regexp.MustCompile(`[^a-z0-9]+`)

// toolName is mcp__<server>__<tool> in the lower snake case tool names take, at most 64 characters.
func toolName(server, name string) string {
	clean := func(s string) string { return strings.Trim(unsafeName.ReplaceAllString(strings.ToLower(s), "_"), "_") }
	out := "mcp__" + clean(server) + "__" + clean(name)
	if len(out) > 64 {
		sum := sha256.Sum256([]byte(server + "/" + name))
		out = out[:55] + "_" + hex.EncodeToString(sum[:4])
	}
	return out
}
