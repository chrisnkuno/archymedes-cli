package tui

import (
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// The person's hand on a sub-agent from the Inspector, as Claude Code's task panel gives it: x stops
// one at work (what it found so far becomes its report), m tells it something (one at work reads it
// at its next step; on Friday's engine a finished one starts again with it, keeping what it read).
// Both are session commands (agent-stop, agent-send); the engine says what it did, or why not.

// agentID is how the engine knows a card's sub-agent: its thread id once a thread event named it,
// else the call id it runs under.
func agentID(t *toolItem) string {
	if t.sub != nil && t.sub.thread != "" {
		return t.sub.thread
	}
	return t.id
}

// agentWorking is whether a card's sub-agent is at work now.
func agentWorking(t *toolItem) bool { return !t.done || backgroundRunning(t) }

// stopAgent is x on a sub-agent.
func (m *Model) stopAgent(t *toolItem) tea.Cmd {
	if t == nil || !delegationTools[t.name] {
		return nil
	}
	if !agentWorking(t) {
		return m.toast(toastInfo, "This sub-agent has already finished")
	}
	return tea.Batch(m.toast(toastInfo, "Stopping "+subagentRole(t)+"…"), m.sessionCommand("agent-stop", agentID(t)))
}

// messageAgent is m on a sub-agent: a line to type what to tell it.
func (m *Model) messageAgent(t *toolItem) tea.Cmd {
	if t == nil || !delegationTools[t.name] {
		return nil
	}
	m.openOverlay(newAgentMessageDialog(m, t))
	return nil
}

type agentMessageDialog struct {
	id, role string
	working  bool
	input    textinput.Model
}

func newAgentMessageDialog(m *Model, t *toolItem) *agentMessageDialog {
	in := textinput.New()
	in.Placeholder = "what it should know or do next"
	in.Prompt = "› "
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Prompt, s.Focused.Text, s.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	in.SetStyles(s)
	in.Focus()
	return &agentMessageDialog{id: agentID(t), role: subagentRole(t), working: agentWorking(t), input: in}
}

func (d *agentMessageDialog) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		return true, nil
	case "enter":
		text := strings.TrimSpace(d.input.Value())
		if text == "" {
			return true, nil
		}
		return true, m.sessionCommand("agent-send", d.id+" "+text)
	}
	var cmd tea.Cmd
	d.input, cmd = d.input.Update(msg)
	return false, cmd
}

func (d *agentMessageDialog) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 80)
	inner := max(width-4, 8)
	d.input.SetWidth(max(inner-2, 4))
	what := "It reads this at its next step."
	if !d.working {
		what = "It has finished: this starts it again, keeping what it already read."
	}
	body := th.Faint.Render(ansi.Truncate(what, inner, "…")) + "\n\n" +
		d.input.View() + "\n" +
		th.Faint.Render(ansi.Truncate("enter send · esc cancel", inner, ""))
	return frame(th, "Message to "+d.role+" · "+d.id, body, width)
}
