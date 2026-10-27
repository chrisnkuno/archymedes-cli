package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// The test binary is also a fake language server when FAKE_LSP=1: every opened or changed
// document gets an empty publish, then, a moment later, an error on each line containing BUG.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_LSP") == "1" {
		fakeServer()
		return
	}
	os.Exit(m.Run())
}

func fakeServer() {
	r := bufio.NewReader(os.Stdin)
	send := func(v any) {
		body, _ := json.Marshal(v)
		fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n%s", len(body), body)
	}
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
		body := make([]byte, length)
		if _, err := io.ReadFull(r, body); err != nil {
			return
		}
		var msg struct {
			ID     any            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		json.Unmarshal(body, &msg)
		switch msg.Method {
		case "initialize", "shutdown":
			send(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{"capabilities": map[string]any{}}})
		case "exit":
			return
		case "textDocument/didOpen", "textDocument/didChange":
			doc := msg.Params["textDocument"].(map[string]any)
			text, _ := doc["text"].(string)
			if changes, ok := msg.Params["contentChanges"].([]any); ok && len(changes) > 0 {
				text = changes[0].(map[string]any)["text"].(string)
			}
			uri := doc["uri"]
			send(map[string]any{"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": map[string]any{"uri": uri, "diagnostics": []any{}}})
			time.Sleep(100 * time.Millisecond)
			var diags []any
			for i, line := range strings.Split(text, "\n") {
				if col := strings.Index(line, "BUG"); col >= 0 {
					diags = append(diags, map[string]any{"range": map[string]any{"start": map[string]any{"line": i, "character": col}}, "severity": 1, "message": "undefined: BUG"})
				}
			}
			send(map[string]any{"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": map[string]any{"uri": uri, "diagnostics": diags}})
		}
	}
}

func fakeManager(t *testing.T, root string) *Manager {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_LSP", "1")
	m := NewManager(root)
	m.servers = []Server{{Name: "fake", Command: exe, Extensions: []string{".fk"}, LanguageID: "fake"}}
	m.settle = 5 * time.Second
	t.Cleanup(m.Close)
	return m
}

func TestAnEditThatBreaksAFileIsToldItsErrors(t *testing.T) {
	root := t.TempDir()
	m := fakeManager(t, root)
	file := filepath.Join(root, "a.fk")
	os.WriteFile(file, []byte("ok\nx := BUG\n"), 0o644)
	edit := Decorate(&tool.Tool{Name: "edit_file", Run: func(context.Context, tool.Context, tool.Args) tool.Result {
		return tool.Text("Edited a.fk.")
	}}, m)

	r := edit.Run(context.Background(), tool.Context{}, tool.Args{"path": "a.fk"})
	if !strings.Contains(r.Content, "Edited a.fk.") || !strings.Contains(r.Content, "1 error(s) in a.fk") || !strings.Contains(r.Content, "a.fk:2:6: error: undefined: BUG") {
		t.Fatalf("after a breaking edit:\n%s", r.Content)
	}
	os.WriteFile(file, []byte("ok\nx := 1\n"), 0o644)
	if r := edit.Run(context.Background(), tool.Context{}, tool.Args{"path": "a.fk"}); r.Content != "Edited a.fk." {
		t.Fatalf("after the fix:\n%s", r.Content)
	}
	if !strings.Contains(strings.Join(m.Status(), "\n"), "fake (") || !strings.Contains(strings.Join(m.Status(), "\n"), "running") {
		t.Fatalf("status %v", m.Status())
	}
	other := Decorate(&tool.Tool{Run: func(context.Context, tool.Context, tool.Args) tool.Result { return tool.Text("wrote") }}, m)
	if r := other.Run(context.Background(), tool.Context{}, tool.Args{"path": "notes.md"}); r.Content != "wrote" {
		t.Fatalf("a file no server covers got a report: %q", r.Content)
	}
}

func TestAServerThatIsNotInstalledIsLeftAlone(t *testing.T) {
	m := NewManager(t.TempDir())
	m.lookPath = func(string) (string, error) { return "", exec.ErrNotFound }
	if d := m.Check(context.Background(), "main.go"); d != nil {
		t.Fatalf("diagnostics without a server: %v", d)
	}
	if !strings.Contains(strings.Join(m.Status(), "\n"), "gopls (gopls): not installed") {
		t.Fatalf("status %v", m.Status())
	}
}

// TestGoplsReportsATypeError runs the real gopls, when it is installed.
func TestGoplsReportsATypeError(t *testing.T) {
	if _, err := exec.LookPath("gopls"); err != nil {
		t.Skip("gopls is not installed")
	}
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "go.mod"), []byte("module demo\n\ngo 1.22\n"), 0o644)
	os.WriteFile(filepath.Join(root, "add.go"), []byte("package demo\n\nfunc Add(a, b int) int { return a + \"b\" }\n"), 0o644)
	m := NewManager(root)
	defer m.Close()
	m.settle = 60 * time.Second
	diags := m.Check(context.Background(), "add.go")
	report := Report("add.go", diags)
	if !strings.Contains(report, "error(s) in add.go") || !strings.Contains(report, "add.go:3:") {
		t.Fatalf("gopls said %+v\nreport:\n%s", diags, report)
	}
}
