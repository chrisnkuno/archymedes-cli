package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestModeOpensFourTilesAndEnterSwitches(t *testing.T) {
	m, agent := newTestModel(t)
	typeText(m, "/mode")
	press(m, tea.KeyEnter, 0)
	p, ok := m.overlay.(*modePicker)
	if !ok {
		t.Fatalf("/mode should open the tiles: %T", m.overlay)
	}
	s := screen(m)
	for _, want := range []string{"● build", "plan", "auto", "defender", "changes nothing", "change asks"} {
		if !strings.Contains(s, want) {
			t.Errorf("the mode tiles lack %q:\n%s", want, s)
		}
	}
	if p.grid.cursor != 1 {
		t.Fatalf("the cursor starts on the current mode: %d", p.grid.cursor)
	}
	press(m, tea.KeyRight, 0)
	press(m, tea.KeyRight, 0)
	run(m, press(m, tea.KeyEnter, 0))
	if m.overlay != nil || len(agent.modes) == 0 || agent.modes[len(agent.modes)-1] != "defender" {
		t.Fatalf("enter on defender should switch: %v", agent.modes)
	}
	typeText(m, "/mode plan") // with a name it switches at once, no tiles
	run(m, press(m, tea.KeyEnter, 0))
	if m.overlay != nil || agent.modes[len(agent.modes)-1] != "plan" {
		t.Fatalf("/mode plan: %v", agent.modes)
	}
}
