package tui

import (
	"context"
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"
)

// A message sent while a turn runs is handed to that turn: the agent gives it to the model after
// the tool calls in flight, so "use tabs, not spaces" lands before the next edit instead of after
// the whole turn. An agent that cannot take it (a turn just concluding, an engine without steering)
// says so, and the message waits in the queue as a turn of its own, as before.

type steerDoneMsg struct {
	text     string
	accepted bool
}

func (m *Model) steer(text string) tea.Cmd {
	agent, id := m.agent, m.session.ID
	if agent == nil || id == "" {
		return m.enqueue(text)
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		accepted, err := agent.Steer(ctx, id, text)
		return steerDoneMsg{text, accepted && err == nil}
	}
}

func (m *Model) steerDone(msg steerDoneMsg) tea.Cmd {
	if !msg.accepted || m.phase != busy {
		return m.enqueue(msg.text)
	}
	m.closeAssistant()
	m.tr.add(&userItem{text: msg.text})
	m.tr.toBottom()
	return m.toast(toastInfo, "Sent to the running turn: read after its current step")
}

func (m *Model) enqueue(text string) tea.Cmd {
	m.queue = append(m.queue, text)
	return m.toast(toastInfo, fmt.Sprintf("Queued (%d) — runs when this turn ends", len(m.queue)))
}
