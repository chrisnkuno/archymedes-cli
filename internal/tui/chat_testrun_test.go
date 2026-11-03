package tui

import (
	"strings"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// A test run's card says how long it should take as it starts, that a long whole suite can wait
// for the end, and afterwards how long it took; a reused pass says what it saved.
func TestATestRunsCardShowsItsExpectedAndActualTime(t *testing.T) {
	m, _ := newTestModel(t)
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "run_command",
		Arguments: map[string]any{"command": "go test ./..."},
		Data:      map[string]any{"testRun": map[string]any{"runner": "go", "p50": 45.0, "p90": 52.0, "basis": "history", "runs": 3.0, "canWait": true, "narrower": "go test ./b", "narrowerP50": 2.0}}})
	s := screen(m)
	if !strings.Contains(s, "≈45s") || !strings.Contains(s, "can wait for the end") {
		t.Fatalf("running card lacks the estimate:\n%s", s)
	}
	if strings.Contains(s, "≈45s–") {
		t.Error("a narrow spread shown as a range")
	}
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "c1", ToolName: "run_command", Content: "exit 0\nok",
		Data: map[string]any{"testRun": map[string]any{"p50": 45.0, "p90": 52.0, "basis": "history", "took": 41.0}}})
	s = screen(m)
	if !strings.Contains(s, "exit 0 · 41s") || strings.Contains(s, "can wait for the end") {
		t.Fatalf("finished card:\n%s", s)
	}

	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c2", ToolName: "run_command", Arguments: map[string]any{"command": "go test ./..."}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "c2", ToolName: "run_command", Content: "exit 0\nok",
		Data: map[string]any{"testRun": map[string]any{"reused": true, "took": 0.0, "saved": 41.0}}})
	if s := screen(m); !strings.Contains(s, "exit 0 · already passed · 41s saved") {
		t.Fatalf("reused card:\n%s", s)
	}

	// Any other command's card carries nothing of the kind.
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c3", ToolName: "run_command", Arguments: map[string]any{"command": "ls"}})
	if m.tools["c3"].test != nil {
		t.Error("a test run read from a command without one")
	}
}

func TestTestRunWords(t *testing.T) {
	m, _ := newTestModel(t)
	wide := &testRun{p50: 30, p90: 120, basis: "guess"}
	if got := wide.expected(); got != "≈30s–2m (guess)" {
		t.Errorf("wide guess: %q", got)
	}
	run := &testRun{p50: 40, p90: 50, basis: "history"}
	if got := run.railNote(10 * time.Second); got != " of ≈40s" {
		t.Errorf("rail: %q", got)
	}
	if got := run.railNote(70 * time.Second); !strings.Contains(got, "slower than usual") {
		t.Errorf("rail past p90: %q", got)
	}
	var none *testRun
	if none.railNote(time.Second) != "" || none.cardNote(m.th) != "" {
		t.Error("no test run, yet words")
	}
	for seconds, want := range map[float64]string{0.4: "400ms", 9.6: "10s", 100: "1m 40s", 3720: "1h 2m"} {
		if got := shortDuration(seconds); got != want {
			t.Errorf("%v: %q, want %q", seconds, got, want)
		}
	}
}
