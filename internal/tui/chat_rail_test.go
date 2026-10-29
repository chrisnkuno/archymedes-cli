package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/project"
)

// railModel is a test model in a project folder holding f.go, with a conversation under way.
func railModel(t *testing.T, width int) *Model {
	t.Helper()
	m, _ := newTestModel(t)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "f.go"), []byte("package f\n\nfunc A() int { return 2 }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m.session.Info.Root = root
	m.Update(tea.WindowSizeMsg{Width: width, Height: 30})
	m.tr.add(&userItem{text: "change A"})
	return m
}

func runtimeMsg(ev acp.RuntimeEvent) agentMsg {
	return agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &ev}}}
}

// landEdit sends an edit of f.go and its result, as the engine does.
func landEdit(m *Model) tea.Cmd {
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "e1", ToolName: "edit_file",
		Arguments: map[string]any{"path": "f.go", "oldText": "func A() int { return 1 }", "newText": "func A() int { return 2 }"}}))
	_, cmd := m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "e1", ToolName: "edit_file", Content: "Edited f.go (1 replacement)."}))
	return cmd
}

func TestAnEditCardShowsItsDiffWithTheLineItLandedOn(t *testing.T) {
	m := railModel(t, 100)
	landEdit(m)
	s := screen(m)
	for _, want := range []string{"+1 −1", "⋯ line 3", "3      -func A() int { return 1 }", "3 +func A() int { return 2 }"} {
		if !strings.Contains(s, want) {
			t.Errorf("edit card lacks %q:\n%s", want, s)
		}
	}
}

func TestAnEditLandingRereadsTheChangesAtOnce(t *testing.T) {
	m := railModel(t, 140)
	m.rail.loaded = true // the first read is done; only an edit should start another
	if cmd := landEdit(m); cmd == nil || !m.rail.loading {
		t.Fatal("an edit landing should read the changes again, not wait for the turn to end")
	}
	if m.rail.latest == nil || m.rail.latest.path != "f.go" || m.rail.touched != "f.go" {
		t.Fatalf("the rail should know the latest edit: %+v", m.rail.latest)
	}
	// A second edit while that read is under way is not lost: it is read again after.
	m.markEdited("f.go")
	m.Update(railLoadedMsg{changes: []project.Change{{Path: "f.go", Status: "modified", Added: 1, Removed: 1}}})
	if !m.rail.loading {
		t.Fatal("an edit during a read should start another read when it ends")
	}
}

func TestTheRailSitsBesideTheTranscriptOnlyWhenThereIsRoom(t *testing.T) {
	for _, width := range []int{80, railMinWidth - 1, railMinWidth, 160} {
		m := railModel(t, width)
		landEdit(m)
		m.Update(railLoadedMsg{changes: []project.Change{{Path: "f.go", Status: "modified", Added: 1, Removed: 1}}})
		s := screen(m)
		wide := width >= railMinWidth
		if got := strings.Contains(s, "Latest edit"); got != wide {
			t.Errorf("width %d: rail shown %v, want %v:\n%s", width, got, wide, s)
		}
		if got := strings.Contains(s, "± 1 file"); got == wide {
			t.Errorf("width %d: the top bar counts the changes only when the rail is not shown:\n%s", width, s)
		}
		m.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModAlt})
		if strings.Contains(screen(m), "Latest edit") {
			t.Errorf("width %d: alt+d should hide the rail", width)
		}
	}
}

// TestInvariantNoRowOverflows: whatever is shown — the rail, the Inspector, a sub-agent at work —
// every row of the screen fits the terminal, and the screen is exactly as tall as it.
func TestInvariantNoRowOverflows(t *testing.T) {
	for _, width := range []int{40, 72, 100, railMinWidth, 133, 200} {
		for _, height := range []int{12, 30} {
			m := railModel(t, width)
			m.Update(tea.WindowSizeMsg{Width: width, Height: height})
			m.phase = busy
			landEdit(m)
			startSubagent(m, "d1", 30)
			m.Update(railLoadedMsg{changes: manyChanges(25)})
			views := map[string]func(){
				"chat":      func() {},
				"inspector": func() { m.Update(tea.KeyPressMsg{Code: tea.KeyRight}) },
				"timeline":  func() { m.Update(tea.KeyPressMsg{Code: tea.KeyRight}) },
				"opened":    func() { m.Update(tea.KeyPressMsg{Code: tea.KeyEnter}) },
			}
			for _, name := range []string{"chat", "inspector", "timeline", "opened"} {
				views[name]()
				rows := strings.Split(m.View().Content, "\n")
				if len(rows) != height {
					t.Errorf("%dx%d %s: %d rows", width, height, name, len(rows))
				}
				for i, row := range rows {
					if w := ansi.StringWidth(row); w > width {
						t.Errorf("%dx%d %s: row %d is %d wide: %q", width, height, name, i, w, ansi.Strip(row))
					}
				}
			}
		}
	}
}

func manyChanges(n int) []project.Change {
	var out []project.Change
	for i := range n {
		out = append(out, project.Change{Path: strings.Repeat("deep/", i%4) + "file" + string(rune('a'+i%26)) + ".go", Status: "modified", Added: i, Removed: n - i})
	}
	return out
}

// startSubagent starts a delegation and has its sub-agent make calls, an edit among them; the last
// call is still running.
func startSubagent(m *Model, id string, calls int) {
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: id, ToolName: "delegate_task", Arguments: map[string]any{"task": "make A return two everywhere", "agent": "general"}}))
	for i := range calls {
		call := id + "-" + string(rune('a'+i%26)) + strings.Repeat("x", i/26)
		ev := acp.RuntimeEvent{Type: "tool_call", ToolCallID: call, ToolName: "read_file", Arguments: map[string]any{"path": "f.go"}}
		if i == 1 {
			ev.ToolName, ev.Arguments = "edit_file", map[string]any{"path": "f.go", "oldText": "return 1", "newText": "return 2"}
		}
		m.handleEvent(subagentEvent(id, "general", ev))
		if i < calls-1 {
			m.handleEvent(subagentEvent(id, "general", acp.RuntimeEvent{Type: "tool_result", ToolCallID: call, ToolName: ev.ToolName, Content: "ok"}))
		}
	}
}
