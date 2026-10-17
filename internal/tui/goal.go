package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// /goal <condition>: turns are sent until the condition holds. After each one the agent judges it
// in a separate, tool-less call (met, impossible, or what is still missing) and the next turn is
// sent with what is missing. Bounded by goalMaxTurns; esc, /goal stop or a failed turn ends it.

const goalMaxTurns = 10

type goalState struct {
	condition string
	turns     int
}

func (m *Model) cmdGoal(arg string) tea.Cmd {
	arg = strings.TrimSpace(arg)
	switch {
	case arg == "" && m.goal == nil:
		return m.toast(toastInfo, "/goal <condition> keeps the agent working until it holds, e.g. /goal the test suite passes")
	case arg == "":
		return m.toast(toastInfo, fmt.Sprintf("Goal (turn %d of %d): %s", m.goal.turns, goalMaxTurns, m.goal.condition))
	case arg == "stop" || arg == "clear":
		if m.goal == nil {
			return m.toast(toastInfo, "No goal is set")
		}
		m.goal = nil
		return m.toast(toastInfo, "Goal dropped; the turn in progress finishes")
	case m.phase != ready:
		return m.toast(toastWarn, "/goal between turns; esc stops this one")
	}
	m.goal = &goalState{condition: arg}
	return m.sessionCommand("goal-prompt", arg)
}

// goalTurnEnded asks for the verdict on a turn spent on the goal.
func (m *Model) goalTurnEnded(stop string) tea.Cmd {
	if m.goal == nil {
		return nil
	}
	if stop == "cancelled" || stop == "refusal" {
		m.goal = nil
		return nil
	}
	return m.sessionCommand("goal-check", m.goal.condition)
}

func (m *Model) goalVerdict(result acp.CommandResult) tea.Cmd {
	if m.goal == nil {
		return nil
	}
	switch result.Status {
	case "met":
		m.notice(noticeInfo, "Goal met: "+m.goal.condition+". "+result.Reason)
		m.goal = nil
		return nil
	case "impossible":
		m.notice(noticeWarn, "Goal stopped: "+result.Reason)
		m.goal = nil
		return nil
	}
	if m.goal.turns >= goalMaxTurns {
		m.notice(noticeWarn, fmt.Sprintf("Goal not met after %d turns: %s. /goal %s tries again.", goalMaxTurns, result.Reason, m.goal.condition))
		m.goal = nil
		return nil
	}
	if result.Next == "" {
		m.goal = nil
		return m.toast(toastWarn, "The goal could not continue")
	}
	if m.goal.turns > 0 {
		m.notice(noticeFaint, fmt.Sprintf("Not met yet (%s) — turn %d of %d.", result.Reason, m.goal.turns+1, goalMaxTurns))
	}
	m.goal.turns++
	if m.phase != ready {
		m.queue = append(m.queue, result.Next)
		return nil
	}
	return m.send(result.Next)
}
