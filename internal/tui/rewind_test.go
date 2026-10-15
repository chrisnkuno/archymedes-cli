package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestRewindListsTurnsNewestFirstWithWhatEachChanged(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	submitCommand(m, "/rewind")
	if _, ok := m.overlay.(*rewindPicker); !ok {
		t.Fatal("/rewind opens the picker")
	}
	s := screen(m)
	first, second := strings.Index(s, "fix the flaky test"), strings.Index(s, "add the parser")
	if first < 0 || second < 0 || first > second {
		t.Fatalf("newest turn first:\n%s", s)
	}
	if !strings.Contains(s, "+new line") {
		t.Fatalf("the newest turn's diff is shown:\n%s", s)
	}
	run(m, press(m, tea.KeyDown, 0))
	if !strings.Contains(screen(m), "+new parser") {
		t.Fatalf("moving shows that turn's diff:\n%s", screen(m))
	}
	run(m, press(m, 'c', 0))
	if m.overlay != nil || agent.commands[len(agent.commands)-1] != "rewind:0 code" {
		t.Fatalf("c rewinds the files of the selected turn: %v", agent.commands)
	}
	if !strings.Contains(screen(m), "Rewound to before turn 0 code") {
		t.Fatalf("says what it did:\n%s", screen(m))
	}
}

func TestRewindWithANumberGoesStraightThere(t *testing.T) {
	m, agent := newTestModel(t)
	submitCommand(m, "/rewind 1 conversation")
	if m.overlay != nil || agent.commands[len(agent.commands)-1] != "rewind:1 conversation" {
		t.Fatalf("%v", agent.commands)
	}
}

func TestRewindPickerFitsEverySize(t *testing.T) {
	m, _ := newTestModel(t)
	submitCommand(m, "/rewind")
	for _, size := range [][2]int{{100, 30}, {60, 16}, {40, 12}, {14, 4}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		assertFits(t, m, "rewind picker")
	}
}

func TestCompactAsksTheAgentWithTheFocusAndSaysWhatHappened(t *testing.T) {
	m, agent := newTestModel(t)
	submitCommand(m, "/compact the parser API")
	if agent.commands[len(agent.commands)-1] != "compact:the parser API" {
		t.Fatalf("%v", agent.commands)
	}
	if !strings.Contains(screen(m), "Session cost") { // the fake's default answer, shown as a toast
		t.Fatalf("the answer is shown:\n%s", screen(m))
	}
	m.phase = busy
	before := len(agent.commands)
	submitCommand(m, "/compact")
	if len(agent.commands) != before || !strings.Contains(screen(m), "/compact between turns") {
		t.Fatalf("not during a turn: %v\n%s", agent.commands, screen(m))
	}
}

func TestForkOpensTheCopyAndKeepsTheOriginal(t *testing.T) {
	m, agent := newTestModel(t)
	submitCommand(m, "/fork")
	if agent.resumed != "s2" {
		t.Fatalf("the fork is opened: resumed %q, commands %v", agent.resumed, agent.commands)
	}
	if !strings.Contains(screen(m), "fix the bug (fork)") {
		t.Fatalf("says where it went:\n%s", screen(m))
	}
}
