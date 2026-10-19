package tui

import (
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestComposingLabelSaysWhatTheModelIsWriting(t *testing.T) {
	for _, c := range []struct {
		tool, subject string
		chars         int
		want          string
	}{
		{"write_file", "src/app.ts", 4_200, "writing src/app.ts · 4.2k chars"},
		{"write_file", "", 40, "writing …"},
		{"edit_file", "README.md", 300, "editing README.md"},
		{"run_command", "npm test", 30, "preparing: npm test"},
		{"mcp__docs__search", "", 10, "preparing mcp docs search"},
	} {
		if got := composingLabel(c.tool, c.subject, c.chars); got != c.want {
			t.Errorf("composingLabel(%q, %q, %d) = %q, want %q", c.tool, c.subject, c.chars, got, c.want)
		}
	}
}

func TestAToolCallBeingWrittenIsShownUntilItArrives(t *testing.T) {
	m, _ := newTestModel(t)
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_compose", ToolName: "write_file", Subject: "src/app.ts", Chars: 2_000})
	if m.composing == nil || m.composing.Subject != "src/app.ts" {
		t.Fatalf("composing not recorded: %+v", m.composing)
	}
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "write_file", Arguments: map[string]any{"path": "src/app.ts"}})
	if m.composing != nil {
		t.Fatal("the arrived call should replace the composing label")
	}
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_compose", ToolName: "run_command"})
	m.handleRuntime(acp.RuntimeEvent{Type: "model_turn"})
	if m.composing != nil {
		t.Fatal("a finished model call leaves nothing composing")
	}
}
