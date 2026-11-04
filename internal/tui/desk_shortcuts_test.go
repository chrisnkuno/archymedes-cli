package tui

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// TestGrowthAndAgentsAreOneKeyAndOneClickAway: both are on the dock, first among its chips, with
// their keys; a click on each does what its key does, Agents counts the helpers at work, and alt+i
// opens the Inspector from anywhere, even with something typed.
func TestGrowthAndAgentsAreOneKeyAndOneClickAway(t *testing.T) {
	m, _ := newTestModel(t)
	m.opts.Cwd = t.TempDir()
	m.Update(tea.WindowSizeMsg{Width: 200, Height: 30})
	m.tr.add(&noticeItem{kind: noticeInfo, text: "conversation"})

	dock := func() string {
		lines := strings.Split(screen(m), "\n")
		return lines[len(lines)-1]
	}
	for _, want := range []string{"alt+v▲", "alt+i☺"} {
		if !strings.Contains(dock(), want) {
			t.Errorf("the dock lacks %q:\n%s", want, dock())
		}
	}

	// A helper at work is counted on the dock.
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"task": "port it", "agent": "general", "background": true}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "d1", ToolName: "delegate_task", Content: "started in the background"})
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "t1", ParentToolCallID: "d1", Agent: "general", Status: "running", Background: true}})
	if !strings.Contains(dock(), "alt+i☺ 1 at work") {
		t.Errorf("the dock does not count the helper at work:\n%s", dock())
	}

	click := func(id string) {
		t.Helper()
		_ = m.View()
		time.Sleep(40 * time.Millisecond) // the zone worker scans asynchronously
		box := m.zones.frame.Get("app:" + id)
		if box.IsZero() {
			t.Fatalf("%s is not a click zone on the dock", id)
		}
		_, cmd := m.Update(tea.MouseClickMsg{X: box.StartX + 1, Y: box.StartY, Button: tea.MouseLeft})
		deliver(m, cmd)
	}
	click("growth-panel")
	if !m.growth.shown {
		t.Fatal("a click on Growth in the dock did not show the panel")
	}
	click("inspect")
	if _, ok := m.activeWindow().(*inspectApp); !ok {
		t.Fatalf("a click on Agents opened %T, not the Inspector", m.activeWindow())
	}

	// alt+i, with text in the input: → would move the cursor there, alt+i still opens it.
	m.closeWindow(m.active)
	typeText(m, "half a thought")
	deliver(m, press(m, 'i', tea.ModAlt))
	if _, ok := m.activeWindow().(*inspectApp); !ok {
		t.Fatalf("alt+i opened %T, not the Inspector", m.activeWindow())
	}
	if m.input.value() != "half a thought" {
		t.Errorf("alt+i changed the input: %q", m.input.value())
	}
}

// TestGrowthAndAgentsAreInTheTopBarAtEveryWidth: the dock's chips need a wide terminal; the top
// bar has room at common widths, so both are there, by name, as clicks, and shortened when narrow.
func TestGrowthAndAgentsAreInTheTopBarAtEveryWidth(t *testing.T) {
	m, _ := newTestModel(t)
	m.opts.Cwd = t.TempDir()
	m.tr.add(&noticeItem{kind: noticeInfo, text: "conversation"})
	top := func() string { return strings.Split(screen(m), "\n")[0] }

	m.Update(tea.WindowSizeMsg{Width: 140, Height: 30})
	for _, want := range []string{"▲ growth", "alt+v", "☺ agents", "alt+i"} {
		if !strings.Contains(top(), want) {
			t.Errorf("at 140 columns the top bar lacks %q:\n%s", want, top())
		}
	}
	m.Update(tea.WindowSizeMsg{Width: 90, Height: 30})
	if !strings.Contains(top(), "alt+v") || !strings.Contains(top(), "alt+i") {
		t.Errorf("at 90 columns the keys are gone:\n%s", top())
	}
	for i, l := range strings.Split(screen(m), "\n") {
		if w := ansi.StringWidth(l); w > 90 {
			t.Errorf("row %d is %d columns", i, w)
		}
	}

	m.Update(tea.WindowSizeMsg{Width: 140, Height: 30})
	click := func(id string) {
		t.Helper()
		_ = m.View()
		time.Sleep(40 * time.Millisecond)
		box := m.zones.frame.Get(id)
		if box.IsZero() {
			t.Fatalf("%s is not a click zone", id)
		}
		_, cmd := m.Update(tea.MouseClickMsg{X: box.StartX, Y: box.StartY, Button: tea.MouseLeft})
		deliver(m, cmd)
	}
	click("top:growth")
	if !m.growth.shown {
		t.Fatal("a click on growth in the top bar did not show the panel")
	}
	// With nothing to inspect yet it says so; with a helper at work it opens on it.
	click("top:agents")
	if m.activeWindow() != nil || len(m.toasts) == 0 || !strings.Contains(m.toasts[len(m.toasts)-1].text, "Nothing to inspect yet") {
		t.Fatalf("agents with nothing to inspect: window %T, toasts %+v", m.activeWindow(), m.toasts)
	}
	m.toasts = nil
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"task": "port it", "agent": "general", "background": true}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "d1", ToolName: "delegate_task", Content: "started in the background"})
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "t1", ParentToolCallID: "d1", Agent: "general", Status: "running", Background: true}})
	if !strings.Contains(top(), "☺ agents 1") {
		t.Errorf("the top bar does not count the helper at work:\n%s", top())
	}
	click("top:agents")
	if _, ok := m.activeWindow().(*inspectApp); !ok {
		t.Fatalf("a click on agents opened %T, not the Inspector", m.activeWindow())
	}
}
