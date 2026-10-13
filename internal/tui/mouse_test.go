package tui

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

// click draws the frame (registering its zones, as a person's click always follows a drawn frame),
// gives BubbleZone's worker a moment to store them, and clicks at (x, y).
func click(m *Model, x, y int) tea.Cmd {
	m.View()
	time.Sleep(20 * time.Millisecond)
	_, cmd := m.Update(tea.MouseClickMsg{X: x, Y: y, Button: tea.MouseLeft})
	return cmd
}

// cellOf is the screen cell where text first appears.
func cellOf(t *testing.T, m *Model, text string) (int, int) {
	t.Helper()
	for y, line := range strings.Split(screen(m), "\n") {
		if i := strings.Index(line, text); i >= 0 {
			return ansi.StringWidth(line[:i]), y
		}
	}
	t.Fatalf("%q not on screen:\n%s", text, screen(m))
	return -1, -1
}

// rowOf is the screen row whose text contains s, from the last drawn frame.
func rowOf(t *testing.T, m *Model, s string) int {
	t.Helper()
	for i, line := range strings.Split(screen(m), "\n") {
		if strings.Contains(line, s) {
			return i
		}
	}
	t.Fatalf("%q not on screen:\n%s", s, screen(m))
	return -1
}

func TestClickingAToolCardTogglesOnlyThatCard(t *testing.T) {
	m, _ := newTestModel(t)
	first := &toolItem{id: "c1", name: "read_file", args: map[string]any{"path": "a.go"}, done: true, result: "alpha body"}
	second := &toolItem{id: "c2", name: "read_file", args: map[string]any{"path": "b.go"}, done: true, result: "beta body"}
	m.tr.add(first)
	m.tr.add(second)
	click(m, 5, rowOf(t, m, "a.go"))
	if !first.open || second.open || !strings.Contains(screen(m), "alpha body") || strings.Contains(screen(m), "beta body") {
		t.Fatalf("first=%v second=%v\n%s", first.open, second.open, screen(m))
	}
	click(m, 5, rowOf(t, m, "a.go"))
	if first.open {
		t.Fatal("a second click folds it again")
	}
}

func TestClickingAToastDismissesIt(t *testing.T) {
	m, _ := newTestModel(t)
	m.toast(toastInfo, "dismiss me")
	row := rowOf(t, m, "dismiss me")
	line := strings.Split(screen(m), "\n")[row]
	click(m, strings.Index(line, "dismiss me"), row)
	if len(m.toasts) != 0 || strings.Contains(screen(m), "dismiss me") {
		t.Fatal("toast still there")
	}
}

func TestClickingAPaletteRowRunsItAndOutsideCloses(t *testing.T) {
	m, agent := newTestModel(t)
	press(m, 'p', tea.ModCtrl)
	typeText(m, "pla")
	x, y := cellOf(t, m, "/plan ")
	run(m, click(m, x+1, y))
	if m.overlay != nil || len(agent.modes) != 1 || agent.modes[0] != "plan" {
		t.Fatalf("overlay=%T modes=%v", m.overlay, agent.modes)
	}
	press(m, 'p', tea.ModCtrl)
	screen(m)
	click(m, 0, m.height-1)
	if m.overlay != nil {
		t.Fatal("a click outside the dialog closes it")
	}
}

func TestClicksNeverAnswerAnApproval(t *testing.T) {
	m, _ := newTestModel(t)
	var answers []string
	m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{Title: "rm -rf"}, []acp.PermissionOption{{OptionID: "allow", Name: "Allow"}}, func(id string) { answers = append(answers, id) })})
	click(m, 5, rowOf(t, m, "Allow"))
	if len(answers) != 0 || m.approval == nil {
		t.Fatal("a click answered the approval")
	}
}
