package tui

import (
	"context"
	"time"

	tea "charm.land/bubbletea/v2"
)

// A message sent while a turn runs waits in the queue a few seconds (chat_queue.go), then is handed
// to that turn: the agent gives it to the model after the tool calls in flight, so "use tabs, not
// spaces" lands before the next edit instead of after the whole turn. An agent that cannot take it
// (a turn just concluding, an engine without steering) says so, and the message stays in the queue
// as a turn of its own.

type steerDoneMsg struct {
	queued   int // the queue entry it came from
	text     string
	accepted bool
}

// steer hands queued message queued (its id) to the running turn.
func (m *Model) steer(queued int, text string) tea.Cmd {
	agent, id := m.agent, m.session.ID
	if agent == nil || id == "" {
		return func() tea.Msg { return steerDoneMsg{queued, text, false} }
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		accepted, err := agent.Steer(ctx, id, text)
		return steerDoneMsg{queued, text, accepted && err == nil}
	}
}

// steerDone takes a steered message out of the queue and into the conversation; one the turn did
// not take stays queued, for the next turn.
func (m *Model) steerDone(msg steerDoneMsg) tea.Cmd {
	i := m.queueIndex(msg.queued)
	if !msg.accepted || m.phase != busy {
		if i >= 0 {
			m.queue[i].sending, m.queue[i].due = false, time.Time{}
		}
		return nil
	}
	if i >= 0 {
		m.dropQueued(i)
	}
	m.closeAssistant()
	m.tr.add(&userItem{text: msg.text})
	m.tr.toBottom()
	return m.toast(toastInfo, "Sent to the running turn: read after its current step")
}
