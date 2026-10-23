package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/core/server"
)

// The Go engine against a real model, on a throwaway project: the provider and key come from the
// person's own settings. Run with FRIDAY_LIVE=1 go test ./cmd/friday -run Live -v (it spends a
// few cents at most); FRIDAY_LIVE_PROVIDER and FRIDAY_LIVE_MODEL pick another model.

const liveAdd = "package calc\n\n// Add returns the sum of a and b.\nfunc Add(a, b int) int {\n\treturn a - b\n}\n"

const liveAddTest = "package calc\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(2, 3); got != 5 {\n\t\tt.Fatalf(\"Add(2, 3) = %d, want 5\", got)\n\t}\n}\n"

func liveProject(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{"go.mod": "module example.com/calc\n\ngo 1.22\n", "add.go": liveAdd, "add_test.go": liveAddTest, "README.md": "# calc\n"}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func liveTurn(t *testing.T, c *acp.Client, id, prompt string) collected {
	t.Helper()
	var got collected
	done := make(chan error, 1)
	go func() { _, err := c.Prompt(context.Background(), id, prompt); done <- err }()
	timeout := time.After(6 * time.Minute)
	for {
		select {
		case msg := <-c.Messages():
			switch m := msg.(type) {
			case acp.TextChunk:
				got.text += m.Text
			case acp.AgentEvent:
				got.events = append(got.events, m.Event)
				if ev := m.Event; ev.Type == "runtime" && ev.Event != nil && ev.Event.Type == "tool_call" {
					t.Logf("tool  %s %v", ev.Event.ToolName, ev.Event.Arguments)
				}
				if ev := m.Event; ev.Type == "subagent" && ev.Event != nil && ev.Event.Type == "tool_call" {
					t.Logf("  sub %s: %s %v", ev.Agent, ev.Event.ToolName, ev.Event.Arguments)
				}
				if ev := m.Event; ev.Type == "thread" && ev.Thread != nil {
					t.Logf("thread %s (%s) %s background=%v %s", ev.Thread.ID, ev.Thread.Agent, ev.Thread.Status, ev.Thread.Background, ev.Thread.Report)
				}
				if ev := m.Event; ev.Type == "runtime" && ev.Event != nil && (ev.Event.Type == "runtime_stop" || ev.Event.Type == "provider_retry") {
					t.Logf("%s %s %s %s", ev.Event.Type, ev.Event.Status, ev.Event.Reason, ev.Event.Summary)
				}
				if ev := m.Event; ev.Type == "runtime" && ev.Event != nil && ev.Event.Type == "tool_result" {
					t.Logf("result %s error=%v %.200q", ev.Event.ToolName, ev.Event.IsError, ev.Event.Content)
				}
			case acp.PermissionRequest:
				t.Logf("asked: %s", m.ToolCall.Title)
				m.Answer("allow")
			case acp.QuestionRequest:
				m.Answer("")
			case acp.TurnEnded:
				got.stop = m.StopReason
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				return got
			case acp.Exited:
				t.Fatalf("engine exited: %v %s", m.Err, m.Stderr)
			}
		case <-timeout:
			t.Fatalf("the turn took more than 6 minutes; so far: %q", got.text)
		}
	}
}

func TestLiveGoEngine(t *testing.T) {
	if os.Getenv("FRIDAY_LIVE") != "1" {
		t.Skip("set FRIDAY_LIVE=1 to run against a real model")
	}
	root := liveProject(t)
	opts := server.Options{Cwd: root, ConfigDir: config.Default(), Environ: os.Environ(), Provider: os.Getenv("FRIDAY_LIVE_PROVIDER"), Model: os.Getenv("FRIDAY_LIVE_MODEL")}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	agent, err := startGoEngine(opts, nil)(ctx)
	if err != nil {
		t.Fatal(err)
	}
	c := agent.(*acp.Client)
	defer c.Close()
	sess, err := c.NewSession(ctx, root, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("session %s on %s/%s", sess.ID, sess.Info.Provider, sess.Info.Model)

	started := time.Now()
	explore := liveTurn(t, c, sess.ID, "Start a background explore sub-agent (delegate_readonly_task with background: true) to find where the function Add is defined and what it returns. While it runs, read go.mod yourself. Then collect its report with wait_agents and tell me the file, the line and what Add returns. Do not change anything.")
	t.Logf("explore turn: %s, %q", time.Since(started).Round(time.Second), explore.text)
	var statuses []string
	for _, ev := range explore.events {
		if ev.Type == "thread" && ev.Thread != nil && ev.Thread.Background {
			statuses = append(statuses, ev.Thread.Status)
		}
	}
	if strings.Join(statuses, ",") != "running,done" {
		t.Errorf("a background sub-agent should run and finish within the turn: %v", statuses)
	}
	if !strings.Contains(explore.text, "add.go") {
		t.Errorf("the answer should name add.go: %q", explore.text)
	}

	if err := c.SetMode(context.Background(), sess.ID, "auto"); err != nil {
		t.Fatal(err)
	}
	started = time.Now()
	fix := liveTurn(t, c, sess.ID, "Fix the bug in Add so that go test ./... passes, and run the tests to show it.")
	t.Logf("fix turn: %s, %q", time.Since(started).Round(time.Second), fix.text)
	data, _ := os.ReadFile(filepath.Join(root, "add.go"))
	if !strings.Contains(string(data), "a + b") {
		t.Errorf("add.go was not fixed:\n%s", data)
	}
	if _, err := exec.LookPath("go"); err == nil {
		cmd := exec.Command("go", "test", "./...")
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Errorf("tests still fail after the fix:\n%s", out)
		}
	}
	ran := false
	for _, ev := range fix.events {
		if ev.Type == "runtime" && ev.Event != nil && ev.Event.Type == "tool_call" && strings.Contains(stringArg(ev.Event.Arguments, "command"), "go test") {
			ran = true
		}
	}
	if !ran {
		t.Errorf("the fix turn never ran go test")
	}
}

func stringArg(args map[string]any, name string) string {
	value, _ := args[name].(string)
	return value
}
