package tui

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// busyWith starts a turn that never ends here, and queues each text behind it.
func busyWith(t *testing.T, texts ...string) (*Model, *fakeAgent) {
	t.Helper()
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	typeText(m, "first")
	press(m, tea.KeyEnter, 0) // the turn runs; its end is never delivered
	if m.phase != busy {
		t.Fatal("no turn is running")
	}
	for _, text := range texts {
		typeText(m, text)
		run(m, press(m, tea.KeyEnter, 0))
	}
	return m, agent
}

func queued(m *Model) []string {
	var out []string
	for _, q := range m.queue {
		out = append(out, q.text)
	}
	return out
}

// dueNow makes every countdown run out, and lets the queue's clock tick.
func dueNow(m *Model) {
	for i := range m.queue {
		if !m.queue[i].due.IsZero() {
			m.queue[i].due = time.Now().Add(-time.Second)
		}
	}
	tick(m)
}

// tick lets the queue's clock tick and runs what it sends.
func tick(m *Model) {
	_, cmd := m.Update(queueTickMsg{})
	run(m, cmd)
}

// TestAMessageSentDuringARunWaitsInAQueueAboveTheInput: it is not sent at once; it is listed above
// the input, numbered, with how many wait and when each goes in.
func TestAMessageSentDuringARunWaitsInAQueueAboveTheInput(t *testing.T) {
	m, agent := busyWith(t, "use tabs, not spaces", "and add a test")
	if len(agent.steered) != 0 {
		t.Fatalf("sent at once: %q", agent.steered)
	}
	if got := queued(m); strings.Join(got, "|") != "use tabs, not spaces|and add a test" {
		t.Fatalf("queue %q", got)
	}
	s := screen(m)
	for _, want := range []string{"2 waiting", "1  use tabs, not spaces", "2  and add a test", "into this turn in"} {
		if !strings.Contains(s, want) {
			t.Errorf("the queue lacks %q:\n%s", want, s)
		}
	}
	lines := strings.Split(s, "\n")
	queueRow, inputRow := -1, -1
	for i, l := range lines {
		if strings.Contains(l, "use tabs, not spaces") {
			queueRow = i
		}
		if strings.Contains(l, "Ask Friday") || strings.Contains(l, "›") && i > queueRow && queueRow >= 0 && inputRow < 0 {
			inputRow = i
		}
	}
	if queueRow < 0 || inputRow < 0 || queueRow > inputRow {
		t.Errorf("the queue is not above the input (queue row %d, input row %d)", queueRow, inputRow)
	}
	for i, l := range lines {
		if w := ansi.StringWidth(l); w > 120 {
			t.Errorf("row %d is %d columns", i, w)
		}
	}
}

// TestAfterAFewSecondsAQueuedMessageSteersTheRun: when its countdown runs out it goes into the running
// turn, first in line first, and leaves the queue for the conversation.
func TestAfterAFewSecondsAQueuedMessageSteersTheRun(t *testing.T) {
	m, agent := busyWith(t, "use tabs", "then lint")
	if steerDelay < 3*time.Second || steerDelay > 10*time.Second {
		t.Fatalf("a queued message waits %v, not a few seconds", steerDelay)
	}
	if d := time.Until(m.queue[0].due); d <= 0 || d > steerDelay {
		t.Fatalf("the first countdown has %v left, want it running and at most %v", d, steerDelay)
	}
	m.queue[0].due = time.Now().Add(-time.Second)
	tick(m)
	if strings.Join(agent.steered, "|") != "use tabs" || strings.Join(queued(m), "|") != "then lint" {
		t.Fatalf("steered %q, queue %q", agent.steered, queued(m))
	}
	if !strings.Contains(screen(m), "use tabs") {
		t.Error("the steered message is not in the conversation")
	}
}

// TestAnEngineThatCannotSteerKeepsTheMessageForTheNextTurn: refused, it stays queued, its countdown
// gone, and runs as a turn of its own when this one ends.
func TestAnEngineThatCannotSteerKeepsTheMessageForTheNextTurn(t *testing.T) {
	m, agent := newTestModel(t)
	agent.cannotSteer = true
	typeText(m, "first")
	first := press(m, tea.KeyEnter, 0)
	typeText(m, "second")
	run(m, press(m, tea.KeyEnter, 0))
	dueNow(m)
	// Refused (Claude Code takes a message only while one of its tools runs): it stays queued and is
	// offered again while the turn runs, rather than waiting for the turn to end.
	if strings.Join(queued(m), "|") != "second" || m.queue[0].due.IsZero() || m.queue[0].sending {
		t.Fatalf("refused steer: queue %+v", m.queue)
	}
	if !strings.Contains(screen(m), "next step") {
		t.Errorf("a message waiting for a step Friday can take it at does not say so:\n%s", screen(m))
	}
	dueNow(m) // refused again
	run(m, first)
	if len(agent.prompts) != 2 || agent.prompts[1] != "second" {
		t.Fatalf("prompts = %q", agent.prompts)
	}
}

// TestTheQueueCanBeWorkedWithTheKeys: ↑ goes into it (and stops the countdowns while there), enter
// brings a message back to edit, x drops one, alt+↑/↓ move one, s sends one into the turn now, esc
// goes back to the input.
func TestTheQueueCanBeWorkedWithTheKeys(t *testing.T) {
	m, agent := busyWith(t, "one", "two", "three")

	press(m, tea.KeyUp, 0)
	if m.queueSel != 2 {
		t.Fatalf("↑ from the input selects the last queued message, got %d", m.queueSel)
	}
	dueNow(m)
	if len(agent.steered) != 0 {
		t.Fatalf("a countdown ran out while the queue was being worked: %q", agent.steered)
	}
	if s := screen(m); !strings.Contains(s, "enter edit") || !strings.Contains(s, "x drop") || !strings.Contains(s, "s send now") {
		t.Errorf("the queue's keys are not shown:\n%s", s)
	}

	press(m, tea.KeyUp, tea.ModAlt) // "three" moves above "two"
	if strings.Join(queued(m), "|") != "one|three|two" || m.queueSel != 1 {
		t.Fatalf("alt+↑: %q, selected %d", queued(m), m.queueSel)
	}
	press(m, tea.KeyDown, tea.ModAlt)
	if strings.Join(queued(m), "|") != "one|two|three" || m.queueSel != 2 {
		t.Fatalf("alt+↓: %q, selected %d", queued(m), m.queueSel)
	}

	press(m, 'x', 0) // drop "three"
	if strings.Join(queued(m), "|") != "one|two" || m.queueSel != 1 {
		t.Fatalf("x: %q, selected %d", queued(m), m.queueSel)
	}
	press(m, tea.KeyUp, 0)
	run(m, press(m, 's', 0)) // "one" into the turn now
	if strings.Join(agent.steered, "|") != "one" || strings.Join(queued(m), "|") != "two" {
		t.Fatalf("s: steered %q, queue %q", agent.steered, queued(m))
	}

	press(m, tea.KeyEnter, 0) // "two" back into the input
	if m.input.value() != "two" || len(m.queue) != 0 || m.queueSel != -1 {
		t.Fatalf("enter: input %q, queue %q, selected %d", m.input.value(), queued(m), m.queueSel)
	}

	m.input.take()
	typeText(m, "four")
	run(m, press(m, tea.KeyEnter, 0))
	press(m, tea.KeyUp, 0)
	press(m, tea.KeyEscape, 0)
	if m.queueSel != -1 || m.phase != busy {
		t.Fatalf("esc leaves the queue without stopping the turn: selected %d, phase %v", m.queueSel, m.phase)
	}
	if d := time.Until(m.queue[0].due); d <= 0 {
		t.Errorf("leaving the queue did not restart its countdown: %v", d)
	}
}

// A message the engine refuses at first (Claude Code between its tools) goes into the turn as soon
// as the engine takes it, in the same turn: never stuck until the turn ends.
func TestARefusedMessageIsOfferedAgainAndLandsInTheSameTurn(t *testing.T) {
	m, agent := newTestModel(t)
	agent.cannotSteer = true
	typeText(m, "first")
	press(m, tea.KeyEnter, 0)
	typeText(m, "use tabs")
	run(m, press(m, tea.KeyEnter, 0))
	dueNow(m)
	if len(m.queue) != 1 {
		t.Fatalf("refused, it should still be queued: %+v", m.queue)
	}
	agent.mu.Lock()
	agent.cannotSteer = false // a tool started: the engine takes messages now
	agent.mu.Unlock()
	dueNow(m)
	if len(m.queue) != 0 || m.phase != busy {
		t.Fatalf("not taken into the running turn: queue %+v, phase %v", m.queue, m.phase)
	}
	agent.mu.Lock()
	defer agent.mu.Unlock()
	if n := len(agent.steered); n < 2 || agent.steered[n-1] != "use tabs" {
		t.Fatalf("steered %q", agent.steered)
	}
}

// INVARIANT: however often the engine refuses, a message is offered at most once per steerRetry
// (counted against the time that really passed) and is never on its way twice at once.
func TestRefusedMessagesAreOfferedAtAMeasuredPace(t *testing.T) {
	m, agent := newTestModel(t)
	agent.cannotSteer = true
	typeText(m, "first")
	press(m, tea.KeyEnter, 0)
	typeText(m, "later")
	run(m, press(m, tea.KeyEnter, 0))
	began := time.Now()
	dueNow(m)
	for range 12 {
		tick(m) // each runs the queue's real half-second clock
		if len(m.queue) == 1 && m.queue[0].sending {
			t.Fatal("left on its way after the engine answered")
		}
	}
	agent.mu.Lock()
	offers := len(agent.steered)
	agent.mu.Unlock()
	if most := 1 + int(time.Since(began)/steerRetry); offers > most || offers < 2 {
		t.Fatalf("offered %d times in %v; between 2 and %d expected", offers, time.Since(began).Round(time.Millisecond), most)
	}
}
