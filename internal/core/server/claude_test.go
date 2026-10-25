package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/claude/claudetest"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

func TestMain(m *testing.M) {
	if claudetest.Active() {
		claudetest.Main()
		return
	}
	os.Exit(m.Run())
}

// TestASessionSwitchesToClaudeCodeAndBackKeepingTheConversation is the model picker choosing
// Claude in a Go-engine session, a turn on it, and a switch back to Friday's own model.
func TestASessionSwitchesToClaudeCodeAndBackKeepingTheConversation(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "claude.log")
	t.Setenv(claudetest.Env, "1")
	t.Setenv("FAKE_CLAUDE_LOG", log)
	root := t.TempDir()
	var calls atomic.Int64
	srvOut, clientIn := io.Pipe()
	clientOut, srvIn := io.Pipe()
	srv := New(srvIn, Options{Cwd: root, ConfigDir: t.TempDir(), Provider: "groq",
		Environ: append(os.Environ(), "GROQ_API_KEY=k", "ARCHYMEDES_TITLES=off", "ARCHYMEDES_CLAUDE_PATH="+exe),
		Open: func(_ context.Context, _ llm.Selection, _ llm.Env, id string) (fantasy.LanguageModel, error) {
			return countingModel{id: id, calls: &calls}, nil
		}})
	done := make(chan struct{})
	go func() { _ = srv.Serve(context.Background(), srvOut); close(done) }()
	replies := bufio.NewScanner(clientOut)
	replies.Buffer(make([]byte, 64<<10), 16<<20)
	var updates []string
	read := func(id string) map[string]any {
		for replies.Scan() {
			var f map[string]any
			_ = json.Unmarshal(replies.Bytes(), &f)
			if f["method"] == "session/update" {
				updates = append(updates, replies.Text())
			}
			if f["method"] == "session/request_permission" {
				// The person allows it, as the interface's dialog would.
				_, _ = io.WriteString(clientIn, fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"result":{"outcome":"selected","selectedOptionId":"allow"}}`+"\n", f["id"]))
			}
			if f["method"] == nil && fmt.Sprint(f["id"]) == id {
				return f
			}
		}
		t.Fatalf("no reply %s", id)
		return nil
	}
	send := func(line string) { _, _ = io.WriteString(clientIn, line+"\n") }
	info := func(reply map[string]any) map[string]any {
		result, _ := reply["result"].(map[string]any)
		meta, _ := result["_meta"].(map[string]any)
		archymedes, _ := meta["archymedes"].(map[string]any)
		if archymedes == nil {
			t.Fatalf("reply = %v", reply)
		}
		return archymedes
	}

	send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	read("1")
	send(`{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"` + root + `"}}`)
	sessionID := read("2")["result"].(map[string]any)["sessionId"].(string)
	prompt := func(id, text string) map[string]any {
		send(`{"jsonrpc":"2.0","id":` + id + `,"method":"session/prompt","params":{"sessionId":"` + sessionID + `","prompt":[{"type":"text","text":"` + text + `"}]}}`)
		return read(id)
	}
	prompt("3", "hello groq")

	send(`{"jsonrpc":"2.0","id":4,"method":"_archymedes/session/set_model","params":{"sessionId":"` + sessionID + `","provider":"claude","model":"opus"}}`)
	if got := info(read("4")); got["provider"] != "claude" || got["model"] != "opus" || got["providerLabel"] != "Claude (your subscription)" {
		t.Fatalf("switched to %v", got)
	}
	if reply := prompt("5", "please run it"); reply["result"].(map[string]any)["stopReason"] != "end_turn" {
		t.Fatalf("reply = %v", reply)
	}
	logged, _ := os.ReadFile(log)
	if !strings.Contains(string(logged), "User: hello groq\\n\\nAssistant: answered") || !strings.Contains(string(logged), `answer {"behavior":"allow"`) {
		t.Fatalf("Claude was told the conversation and asked through the client:\n%s", logged)
	}
	if !strings.Contains(strings.Join(updates, "\n"), `"text":"Done."`) {
		t.Fatalf("Claude's reply reached the client:\n%s", strings.Join(updates, "\n"))
	}
	send(`{"jsonrpc":"2.0","id":6,"method":"_archymedes/session/command","params":{"sessionId":"` + sessionID + `","command":"cost"}}`)
	if text := fmt.Sprint(read("6")["result"]); !strings.Contains(text, "Billed to your Claude plan") {
		t.Fatalf("cost = %s", text)
	}

	send(`{"jsonrpc":"2.0","id":7,"method":"_archymedes/session/set_model","params":{"sessionId":"` + sessionID + `","provider":"groq","model":"llama"}}`)
	if got := info(read("7")); got["provider"] != "groq" {
		t.Fatalf("switched back to %v", got)
	}
	before := calls.Load()
	prompt("8", "and groq again")
	if calls.Load() != before+1 {
		t.Fatal("Friday's own model ran the turn after switching back")
	}
	store, err := thread.Open(root, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	meta, _ := store.Meta()
	messages, _ := store.Messages(thread.Root)
	if meta.ClaudeSession != "claude-1" || meta.EngineSeen["claude"] != 4 || len(messages) != 6 || textOf(messages[3]) != "Done." {
		t.Fatalf("meta = %+v, %d messages", meta, len(messages))
	}
	_ = clientIn.Close()
	<-done
}

// TestASessionThatStartsOnClaudeResumesClaudesConversation is `--provider claude` (or Claude
// remembered as the default): Claude Code from the first turn, and its own session resumed later.
func TestASessionThatStartsOnClaudeResumesClaudesConversation(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "claude.log")
	t.Setenv(claudetest.Env, "1")
	t.Setenv("FAKE_CLAUDE_LOG", log)
	root := t.TempDir()
	run := func(method string, resume bool) {
		srvOut, clientIn := io.Pipe()
		clientOut, srvIn := io.Pipe()
		srv := New(srvIn, Options{Cwd: root, ConfigDir: t.TempDir(), Environ: append(os.Environ(), "ARCHYMEDES_PROVIDER=claude", "ARCHYMEDES_CLAUDE_PATH="+exe)})
		done := make(chan struct{})
		go func() { _ = srv.Serve(context.Background(), srvOut); close(done) }()
		replies := bufio.NewScanner(clientOut)
		read := func(id string) map[string]any {
			for replies.Scan() {
				var f map[string]any
				_ = json.Unmarshal(replies.Bytes(), &f)
				if f["method"] == nil && fmt.Sprint(f["id"]) == id {
					return f
				}
			}
			t.Fatalf("no reply %s", id)
			return nil
		}
		send := func(line string) { _, _ = io.WriteString(clientIn, line+"\n") }
		send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
		read("1")
		params := `{"cwd":"` + root + `"}`
		if resume {
			params = `{"cwd":"` + root + `","sessionId":"latest"}`
		}
		send(`{"jsonrpc":"2.0","id":2,"method":"` + method + `","params":` + params + `}`)
		reply := read("2")
		result, _ := reply["result"].(map[string]any)
		meta, _ := result["_meta"].(map[string]any)
		info, _ := meta["archymedes"].(map[string]any)
		if info["provider"] != "claude" {
			t.Fatalf("%s: %v", method, reply)
		}
		send(`{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"` + info["sessionId"].(string) + `","prompt":[{"type":"text","text":"hi"}]}}`)
		read("3")
		_ = clientIn.Close()
		<-done
	}
	run("session/new", false)
	run("session/load", true)
	logged, _ := os.ReadFile(log)
	starts := strings.Count(string(logged), "start ")
	if starts != 2 || !strings.Contains(string(logged), "--resume claude-1") || strings.Contains(string(logged), "earlier_conversation") {
		t.Fatalf("the second start resumes Claude's own conversation, untold:\n%s", logged)
	}
}
