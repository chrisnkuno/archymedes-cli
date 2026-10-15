package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestReviewFindingsAreABlockWorstFirstWithWhereEachIs(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	submitCommand(m, "/review the parser")
	if agent.commands[len(agent.commands)-1] != "review:the parser" {
		t.Fatalf("%v", agent.commands)
	}
	s := screen(m)
	for _, want := range []string{"review of the uncommitted changes", "2 findings", "1. high", "loses the last token", "parser.go:12", "the loop stops one short", "2. low", "lexer.go", "One real bug.", `"fix 1"`} {
		if !strings.Contains(s, want) {
			t.Fatalf("lacks %q:\n%s", want, s)
		}
	}
	if strings.Index(s, "loses the last token") > strings.Index(s, "unused field") {
		t.Fatal("worst first")
	}
	for _, size := range [][2]int{{60, 20}, {24, 8}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		assertFits(t, m, "review block")
	}
}

func TestBranchesReviewsTheSelectedBranchAgainstHead(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 36})
	openChangesAt(t, m, branchedProject(t))
	deliver(m, press(m, 'b', 0))
	selectUntil(t, m, "add the feature")
	deliver(m, press(m, 'R', 0))
	agent.mu.Lock()
	last := agent.commands[len(agent.commands)-1]
	agent.mu.Unlock()
	if last != "review:branch feature" {
		t.Fatalf("R reviews the branch: %v", agent.commands)
	}
}
