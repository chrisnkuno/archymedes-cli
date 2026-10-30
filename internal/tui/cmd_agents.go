package tui

import (
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// Helpers the person starts themselves: /agent [role] <task>, or alt+a on what is typed. Each runs
// in the background on the engine (session command "spawn"), so several work at once while the
// conversation carries on, mid-turn included. No tool call stands behind one: its card is drawn
// from its thread events (call id "user:…"), and from then on it is a delegation card like any
// other — live in the rail, its whole timeline in the Inspector (→), its report folded in.

// userAgentPrefix starts the call id the engine gives a helper the person started
// (agents.UserCallPrefix).
const userAgentPrefix = "user:"

func (m *Model) cmdAgent(arg string) tea.Cmd {
	if strings.TrimSpace(arg) == "" {
		return m.toast(toastInfo, "/agent <task> starts a helper in the background, e.g. /agent explore map the API; alt+a sends what you typed to one")
	}
	return m.startAgent(arg)
}

// agentFromInput is alt+a: what is typed goes to a new helper instead of to Friday.
func (m *Model) agentFromInput() tea.Cmd {
	if strings.TrimSpace(m.input.value()) == "" {
		return m.toast(toastInfo, "Type a task, then alt+a hands it to a new helper in the background")
	}
	return m.startAgent(m.input.take())
}

func (m *Model) startAgent(task string) tea.Cmd {
	return tea.Batch(m.toast(toastInfo, "Starting a helper…"), m.sessionCommand("spawn", strings.TrimSpace(task)))
}

// userAgentCard is the card of a helper the person started, made from its first thread event;
// nil for any other call id.
func (m *Model) userAgentCard(th *acp.ThreadInfo) *toolItem {
	if !strings.HasPrefix(th.ParentToolCallID, userAgentPrefix) {
		return nil
	}
	t := &toolItem{
		id: th.ParentToolCallID, name: "delegate_task", started: time.Now(),
		args: map[string]any{"task": th.Brief, "agent": th.Agent, "background": true},
		// Like a model's background delegation, its "call" is over at once; the card follows the
		// thread until it ends.
		done: true, ended: time.Now(), result: "Started in the background; its report replaces this when it ends.",
		sub: &subagentRun{agent: th.Agent, background: true, status: th.Status, thread: th.ID},
	}
	m.tools[t.id] = t
	m.tr.add(t)
	m.tr.toBottom()
	return t
}
