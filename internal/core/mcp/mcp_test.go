package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// The test binary is also a fake MCP server on stdio when FAKE_MCP=1: two pages of tools (echo,
// read-only; fail; crash), each start appended to FAKE_MCP_LOG.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_MCP") == "1" {
		fakeServer()
		return
	}
	os.Exit(m.Run())
}

func fakeServer() {
	if log := os.Getenv("FAKE_MCP_LOG"); log != "" {
		f, _ := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		fmt.Fprintln(f, "start")
		f.Close()
	}
	out := json.NewEncoder(os.Stdout)
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var req struct {
			ID     any            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if json.Unmarshal(sc.Bytes(), &req) != nil || req.ID == nil {
			continue
		}
		reply := func(result any) { out.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}) }
		switch req.Method {
		case "initialize":
			reply(map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "fake"}})
		case "tools/list":
			if req.Params["cursor"] == nil {
				reply(map[string]any{"tools": []any{
					map[string]any{"name": "echo", "description": "Say it back", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string"}}}, "annotations": map[string]any{"readOnlyHint": true}},
				}, "nextCursor": "p2"})
			} else {
				reply(map[string]any{"tools": []any{
					map[string]any{"name": "fail", "description": "Always fails", "inputSchema": map[string]any{"type": "object"}},
					map[string]any{"name": "crash", "description": "Exits", "inputSchema": map[string]any{"type": "object"}},
				}})
			}
		case "tools/call":
			args, _ := req.Params["arguments"].(map[string]any)
			switch req.Params["name"] {
			case "echo":
				reply(map[string]any{"content": []any{map[string]any{"type": "text", "text": fmt.Sprint("echo: ", args["text"])}, map[string]any{"type": "image", "mimeType": "image/png", "data": "AAAA"}}})
			case "fail":
				reply(map[string]any{"content": []any{map[string]any{"type": "text", "text": "it broke"}}, "isError": true})
			case "crash":
				os.Exit(3)
			}
		default:
			out.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "no such method"}})
		}
	}
}

func fakeConfig(t *testing.T, root string) (logFile string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	logFile = filepath.Join(t.TempDir(), "starts.log")
	cfg := map[string]any{"mcpServers": map[string]any{"fake": map[string]any{
		"command": exe, "env": map[string]string{"FAKE_MCP": "1", "FAKE_MCP_LOG": "${FAKE_LOG}"},
	}}}
	data, _ := json.Marshal(cfg)
	os.WriteFile(filepath.Join(root, ".mcp.json"), data, 0o644)
	return logFile
}

func starts(file string) int {
	data, _ := os.ReadFile(file)
	return strings.Count(string(data), "start")
}

func byName(tools []*tool.Tool) map[string]*tool.Tool {
	out := map[string]*tool.Tool{}
	for _, t := range tools {
		out[t.Name] = t
	}
	return out
}

// TestAnIdleServerCostsNoProcessOnceItsToolsAreKnown: listed once, then a new session offers its
// tools from the cache without starting it, and starts it only when a tool is called.
func TestAnIdleServerCostsNoProcessOnceItsToolsAreKnown(t *testing.T) {
	root, cache := t.TempDir(), t.TempDir()
	logFile := fakeConfig(t, root)
	getenv := func(k string) string {
		if k == "FAKE_LOG" {
			return logFile
		}
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	first := NewManager(Files(root, ""), getenv, os.Environ(), cache)
	if got := first.Tools(); len(got) != 0 {
		t.Fatalf("tools before any listing: %d", len(got))
	}
	first.WaitListed(ctx)
	tools := byName(first.Tools())
	echo := tools["mcp__fake__echo"]
	if len(tools) != 3 || echo == nil || !echo.Deferred || echo.Capability != tool.CapResearch || tools["mcp__fake__fail"].Capability != tool.CapExternal || echo.Provenance.Kind != "mcp" {
		t.Fatalf("tools = %+v", tools)
	}
	first.Close()
	if n := starts(logFile); n != 1 {
		t.Fatalf("starts after listing: %d", n)
	}

	second := NewManager(Files(root, ""), getenv, os.Environ(), cache)
	defer second.Close()
	tools = byName(second.Tools())
	if len(tools) != 3 || starts(logFile) != 1 {
		t.Fatalf("a cached server was started (%d starts) or its tools are missing (%d)", starts(logFile), len(tools))
	}
	if !strings.Contains(strings.Join(second.Status(), "\n"), "not started") {
		t.Errorf("status: %v", second.Status())
	}
	r := tools["mcp__fake__echo"].Run(ctx, tool.Context{}, tool.Args{"text": "hi"})
	if r.IsError || !strings.Contains(r.Content, "echo: hi") || !strings.Contains(r.Content, "[image image/png, not shown]") {
		t.Fatalf("echo = %+v", r)
	}
	if n := starts(logFile); n != 2 {
		t.Fatalf("starts after a call: %d", n)
	}
	if r := tools["mcp__fake__fail"].Run(ctx, tool.Context{}, nil); !r.IsError || r.Content != "it broke" {
		t.Fatalf("fail = %+v", r)
	}
	// A server that died is started again for the next call.
	if r := tools["mcp__fake__crash"].Run(ctx, tool.Context{}, nil); !r.IsError {
		t.Fatalf("crash = %+v", r)
	}
	if r := tools["mcp__fake__echo"].Run(ctx, tool.Context{}, tool.Args{"text": "again"}); r.IsError || !strings.Contains(r.Content, "echo: again") {
		t.Fatalf("after a crash = %+v", r)
	}
}

func TestDeclarationsAreReadFromEveryKnownFileAndTheProjectWins(t *testing.T) {
	root, config := t.TempDir(), t.TempDir()
	os.MkdirAll(filepath.Join(root, ".archymedes"), 0o755)
	os.WriteFile(filepath.Join(root, ".archymedes", "mcp.json"), []byte(`{"servers":[{"id":"docs","url":"https://docs.example/mcp","headers":{"Authorization":"Bearer ${DOCS_TOKEN}"}}]}`), 0o644)
	os.WriteFile(filepath.Join(root, ".mcp.json"), []byte(`{"mcpServers":{"docs":{"command":"ignored"},"git":{"command":"git-mcp","args":["--repo","${REPO:-.}"]},"both":{"command":"x","url":"https://x"}}}`), 0o644)
	os.WriteFile(filepath.Join(config, "mcp.json"), []byte(`{"mcpServers":{"web":{"type":"http","url":"http://example.com/mcp"}, "mine":{"command":"mine"}}}`), 0o644)
	getenv := func(k string) string { return map[string]string{"DOCS_TOKEN": "tok"}[k] }
	servers, problems := Load(Files(root, config), getenv)
	var got []string
	for _, s := range servers {
		got = append(got, s.ID+"="+s.Command+s.URL+strings.Join(s.Args, " ")+s.Headers["Authorization"])
	}
	want := "docs=https://docs.example/mcpBearer tok|git=git-mcp--repo .|mine=mine"
	if strings.Join(got, "|") != want {
		t.Fatalf("servers %q, want %q", strings.Join(got, "|"), want)
	}
	if len(problems) != 2 || !strings.Contains(strings.Join(problems, "\n"), "exactly one") || !strings.Contains(strings.Join(problems, "\n"), "https") {
		t.Fatalf("problems %v", problems)
	}
}

// TestStreamableHTTPWithAnEventStreamAndASession: the session id comes back on every request,
// and an answer may arrive as server-sent events after other messages.
func TestStreamableHTTPWithAnEventStreamAndASession(t *testing.T) {
	var sawSession []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		json.Unmarshal(body, &req)
		sawSession = append(sawSession, r.Header.Get("Mcp-Session-Id"))
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "abc")
			json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"protocolVersion": ProtocolVersion}})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/call":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\n\n")
			fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":%v,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"from http\"}]}}\n\n", req.ID)
		}
	}))
	defer srv.Close()
	ctx := context.Background()
	if _, err := Connect(ctx, Server{ID: "h", URL: srv.URL}, nil); err == nil || !strings.Contains(err.Error(), "Authorization") {
		t.Fatalf("without the header: %v", err)
	}
	sawSession = nil
	c, err := Connect(ctx, Server{ID: "h", URL: srv.URL, Headers: map[string]string{"Authorization": "Bearer k"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	res, err := c.Call(ctx, "x", nil)
	if err != nil || res.Text != "from http" {
		t.Fatalf("call = %+v, %v", res, err)
	}
	if strings.Join(sawSession, ",") != ",abc,abc" {
		t.Fatalf("session ids sent: %q", sawSession)
	}
}

func TestToolNamesAreSafeForEveryProvider(t *testing.T) {
	for in, want := range map[[2]string]string{
		{"GitHub", "create-issue"}: "mcp__github__create_issue",
		{"my.server", "Query DB"}:  "mcp__my_server__query_db",
	} {
		if got := toolName(in[0], in[1]); got != want {
			t.Errorf("toolName(%v) = %q, want %q", in, got, want)
		}
	}
	long := toolName(strings.Repeat("s", 40), strings.Repeat("t", 40))
	if len(long) > 64 || long == toolName(strings.Repeat("s", 40), strings.Repeat("t", 41)) {
		t.Errorf("long name %q (%d)", long, len(long))
	}
}

func TestThePromptNamesEachServersToolsButNotTheirSchemas(t *testing.T) {
	root, cache := t.TempDir(), t.TempDir()
	logFile := fakeConfig(t, root)
	m := NewManager(Files(root, ""), func(k string) string { return map[string]string{"FAKE_LOG": logFile}[k] }, os.Environ(), cache)
	defer m.Close()
	if m.Prompt() != "" {
		t.Fatal("a prompt line before the server was listed")
	}
	m.Tools()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	m.WaitListed(ctx)
	p := m.Prompt()
	if !strings.Contains(p, "- fake: echo, fail, crash") || !strings.Contains(p, "tool_search") || strings.Contains(p, "inputSchema") {
		t.Fatalf("%s", p)
	}
}
