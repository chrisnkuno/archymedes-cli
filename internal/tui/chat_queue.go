package tui

import (
	"fmt"
	"math"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// The queue: what was sent while Friday works, listed above the input. A message sent during a run
// waits there for steerDelay, then goes into the running turn (chat_steer.go), read after Friday's
// current step; until then it can be edited, dropped, moved or sent at once. ↑ from an empty input
// goes into the queue and holds every countdown while there. What is still queued when the turn
// ends (or what the engine would not take) runs as a turn of its own, in order.

// steerDelay is how long a message sent during a run waits before it goes into the turn.
const steerDelay = 5 * time.Second

// steerRetry is how soon a message the engine would not take yet is offered again while the turn
// runs (Claude Code takes one only while one of its tools runs).
const steerRetry = 2 * time.Second

// maxQueueRows is how many queued messages are listed at once; the rest are counted.
const maxQueueRows = 5

// queuedMsg is one message waiting. due is when it goes into the running turn; zero, it waits for
// the next turn. sending: handed to the engine, the answer not back yet.
type queuedMsg struct {
	id      int
	text    string
	due     time.Time
	sending bool
	retry   bool // the engine would not take it yet: offered again at its next step
}

type queueTickMsg struct{}

// enqueue adds a message that waits for the next turn.
func (m *Model) enqueue(text string) {
	m.queueSeq++
	m.queue = append(m.queue, queuedMsg{id: m.queueSeq, text: text})
}

// queueDuringRun adds a message sent while a turn runs: into that turn after steerDelay.
func (m *Model) queueDuringRun(text string) tea.Cmd {
	m.queueSeq++
	m.queue = append(m.queue, queuedMsg{id: m.queueSeq, text: text, due: time.Now().Add(steerDelay)})
	return m.queueTicker()
}

// queueTicker keeps one clock running while any countdown does.
func (m *Model) queueTicker() tea.Cmd {
	if m.queueTicking {
		return nil
	}
	m.queueTicking = true
	return tea.Tick(time.Second/2, func(time.Time) tea.Msg { return queueTickMsg{} })
}

// queueTicked sends the first message whose countdown ran out, unless the queue is being worked.
func (m *Model) queueTicked() tea.Cmd {
	m.queueTicking = false
	counting := false
	var cmd tea.Cmd
	for i := range m.queue {
		q := &m.queue[i]
		if q.due.IsZero() || q.sending {
			continue
		}
		counting = true
		if m.queueSel < 0 && m.phase == busy && cmd == nil && !time.Now().Before(q.due) {
			cmd = m.steerQueued(i)
		}
	}
	if !counting || m.phase != busy {
		return cmd
	}
	return tea.Batch(cmd, m.queueTicker())
}

// steerQueued hands queued message i to the running turn.
func (m *Model) steerQueued(i int) tea.Cmd {
	m.queue[i].sending = true
	return m.steer(m.queue[i].id, m.queue[i].text)
}

// queueIndex is where the message with id is, or -1.
func (m *Model) queueIndex(id int) int {
	for i, q := range m.queue {
		if q.id == id {
			return i
		}
	}
	return -1
}

// dropQueued removes message i, keeping the selection on a neighbour.
func (m *Model) dropQueued(i int) {
	m.queue = append(m.queue[:i:i], m.queue[i+1:]...)
	if m.queueSel >= len(m.queue) {
		m.queueSel = len(m.queue) - 1
	}
}

// nextQueued takes the first queued message for a new turn; the rest wait for the one after.
func (m *Model) nextQueued() (string, bool) {
	if len(m.queue) == 0 {
		return "", false
	}
	next := m.queue[0].text
	m.queue = m.queue[1:]
	for i := range m.queue {
		m.queue[i].due, m.queue[i].sending = time.Time{}, false // the turn they were for is over
	}
	if m.queueSel >= len(m.queue) {
		m.queueSel = len(m.queue) - 1
	}
	return next, true
}

// focusQueue selects queued message i and holds the countdowns.
func (m *Model) focusQueue(i int) {
	if m.queueSel < 0 {
		m.queueHeld = time.Now()
	}
	m.queueSel = i
}

// leaveQueue goes back to the input; the countdowns go on from where they were held.
func (m *Model) leaveQueue() tea.Cmd {
	if m.queueSel < 0 {
		return nil
	}
	m.queueSel = -1
	held := time.Since(m.queueHeld)
	for i := range m.queue {
		if !m.queue[i].due.IsZero() {
			m.queue[i].due = m.queue[i].due.Add(held)
		}
	}
	return m.queueTicker()
}

// queueKey is a key while the queue is selected; false lets it through (and leaves the queue).
func (m *Model) queueKey(msg tea.KeyPressMsg) (tea.Cmd, bool) {
	i := m.queueSel
	switch msg.String() {
	case "up":
		if i > 0 {
			m.queueSel--
			return nil, true
		}
		cmd := m.leaveQueue()
		m.enterTranscript() // on past the queue, into the conversation
		return cmd, true
	case "down":
		if i < len(m.queue)-1 {
			m.queueSel++
			return nil, true
		}
		return m.leaveQueue(), true
	case "alt+up":
		if i > 0 {
			m.queue[i-1], m.queue[i] = m.queue[i], m.queue[i-1]
			m.queueSel--
		}
		return nil, true
	case "alt+down":
		if i < len(m.queue)-1 {
			m.queue[i+1], m.queue[i] = m.queue[i], m.queue[i+1]
			m.queueSel++
		}
		return nil, true
	case "enter":
		text := m.queue[i].text
		m.dropQueued(i)
		cmd := m.leaveQueue()
		m.input.area.SetValue(text) // back into the input, to change and send again
		m.input.area.CursorEnd()
		return cmd, true
	case "x", "delete", "backspace":
		m.dropQueued(i)
		if len(m.queue) == 0 {
			return m.leaveQueue(), true
		}
		return nil, true
	case "s":
		if m.queue[i].sending {
			return nil, true
		}
		if m.phase != busy {
			text := m.queue[i].text
			m.dropQueued(i)
			return tea.Batch(m.leaveQueue(), m.send(text)), true
		}
		return m.steerQueued(i), true
	case "esc":
		return m.leaveQueue(), true
	}
	return m.leaveQueue(), false // anything else is typing: back to the input with it
}

// queueRows is how many rows the queue takes above the input.
func (m *Model) queueRows() int { return len(m.queueLines(m.width - 2)) }

// queueLines draws the queue: a heading with how many wait, then each message numbered, with when
// it goes in; nil when nothing is queued.
func (m *Model) queueLines(width int) []string {
	if len(m.queue) == 0 || m.landingVisible() || width < 20 {
		return nil
	}
	th := m.th
	head := th.Strong.Render("Queued") + th.Faint.Render(fmt.Sprintf(" · %d waiting", len(m.queue)))
	if m.queueSel >= 0 {
		head += th.Faint.Render(" · enter edit · x drop · alt+↑↓ move · s send now · esc back")
	} else {
		head += th.Faint.Render(" · ↑ to edit")
	}
	lines := []string{ansi.Truncate(head, width, "…")}
	first := 0
	if len(m.queue) > maxQueueRows {
		first = min(max(m.queueSel-maxQueueRows/2, 0), len(m.queue)-maxQueueRows)
		if m.queueSel < 0 {
			first = 0
		}
	}
	now := time.Now()
	for i := first; i < len(m.queue) && i < first+maxQueueRows; i++ {
		q := m.queue[i]
		var when string
		switch {
		case q.sending:
			when = "sending…"
		case q.due.IsZero() || m.phase != busy:
			when = "next turn"
		case q.retry && m.queueSel < 0:
			when = "into this turn at its next step"
		case m.queueSel >= 0:
			when = "held"
		default:
			when = fmt.Sprintf("into this turn in %ds", int(math.Ceil(max(q.due.Sub(now).Seconds(), 0))))
		}
		label := fmt.Sprintf("%d  %s", i+1, firstLine(q.text))
		right := th.Faint.Render(" · " + when)
		row := ansi.Truncate(label, max(width-ansi.StringWidth(right)-2, 8), "…")
		if i == m.queueSel {
			row = m.barCursor(" " + row + " ")
		} else {
			row = " " + row + " "
		}
		lines = append(lines, row+right)
	}
	if more := len(m.queue) - first - maxQueueRows; more > 0 {
		lines = append(lines, th.Faint.Render(fmt.Sprintf("  … %d more", more)))
	}
	return lines
}
