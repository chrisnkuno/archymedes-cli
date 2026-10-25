package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestEscStepsOutToTheBarsAndTheArrowsWalkThem(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 160, Height: 30})
	m.runAction("keys")
	press(m, tea.KeyEscape, 0)
	if !m.bar.on || m.activeWindow() == nil {
		t.Fatal("esc at a window's top level should step out to the bars, the window still open")
	}
	if !strings.Contains(screen(m), "delete close") {
		t.Fatalf("the dock should say what the keys do here:\n%s", screen(m))
	}
	// Along the row: the tabs (Chat, Keys), then the dock's apps (Files first after Chat).
	press(m, tea.KeyLeft, 0)
	press(m, tea.KeyEnter, 0)
	if m.bar.on || m.active != 0 {
		t.Fatal("enter on the Chat tab should focus Chat")
	}
	press(m, tea.KeyEscape, 0) // an empty input: out to the bars from Chat too
	if !m.bar.on {
		t.Fatal("esc on an empty input should step out to the bars")
	}
	press(m, tea.KeyRight, 0) // the Keys tab
	press(m, tea.KeyDelete, 0)
	if len(m.windows) != 0 {
		t.Fatal("delete should close the window under the cursor")
	}
	press(m, tea.KeyRight, 0) // Files, the first app
	press(m, tea.KeyEnter, 0)
	if _, ok := m.activeWindow().(*filesView); !ok || m.bar.on {
		t.Fatalf("enter on Files should open it: %T", m.activeWindow())
	}
	// Typing on the bars goes back to what has the keys and is not lost.
	m.focus(0)
	press(m, tea.KeyEscape, 0)
	typeText(m, "hi")
	if m.bar.on || m.input.value() != "hi" {
		t.Fatalf("typing on the bars: on=%v input=%q", m.bar.on, m.input.value())
	}
}
