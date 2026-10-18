package tui

import (
	"github.com/chrisnkuno/friday-cli/internal/acp"
	"strings"
	"testing"
)

func TestGoalSendsTurnsUntilTheVerdictSaysMet(t *testing.T) {
	m, agent := newTestModel(t)
	submitCommand(m, "/goal the tests pass")
	// goal-prompt → turn 1 → check: continue → turn 2 → check: met. The fake ends each turn at once.
	deliver(m, nil)
	agent.mu.Lock()
	prompts, checks := append([]string(nil), agent.prompts...), agent.goalChecks
	agent.mu.Unlock()
	if len(prompts) != 2 || prompts[0] != "Work until: the tests pass" || prompts[1] != "Continue: the tests pass" || checks != 2 {
		t.Fatalf("prompts %q, checks %d", prompts, checks)
	}
	s := screen(m)
	if !strings.Contains(s, "Not met yet (two tests still fail)") || !strings.Contains(s, "Goal met: the tests pass. the suite passed") {
		t.Fatalf("says how it went:\n%s", s)
	}
	if m.goal != nil {
		t.Fatal("a met goal is cleared")
	}
}

func TestGoalStopsOnEscAndOnAnEngineThatCannotJudge(t *testing.T) {
	m, _ := newTestModel(t)
	m.goal = &goalState{condition: "x", turns: 1}
	m.phase = busy
	m.cancelTurn()
	if m.goal != nil {
		t.Fatal("esc drops the goal")
	}
	m.phase = ready
	m.goal = &goalState{condition: "x"}
	m.commandDone(commandDoneMsg{command: "goal-check", result: acpError("Unknown session command")})
	if m.goal != nil {
		t.Fatal("an engine without goals ends it")
	}
	submitCommand(m, "/goal")
	if !strings.Contains(screen(m), "/goal <condition>") {
		t.Fatal(screen(m))
	}
}

func acpError(text string) acp.CommandResult { return acp.CommandResult{Kind: "error", Text: text} }
