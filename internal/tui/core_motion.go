package tui

import (
	"time"

	tea "charm.land/bubbletea/v2"
)

// Motion: the tick chains that move the screen, and when they rest. animate starts what the screen
// needs; each chain stops by itself once its reason is gone.
//
// Rest: the home screen's motion (the mark turning, the tour drawer's art, the photo changing) and
// the Showcase's scenes stop while nobody is looking, and start again at the next key, click or
// return to the terminal. Each of those frames is real work, about a fifth of a core at eleven a
// second, and an idle Friday left open in a terminal used to spend it for as long as it stayed open.
// Nobody is looking when the terminal says it lost focus, or when nothing was typed or clicked for
// restAfter.

// animate starts whichever tick chains the screen now needs and are not already running: the
// spinner while the agent starts or works, the landing mark while it is on screen. Each chain
// stops by itself once its reason is gone, so an idle session does not repaint.
func (m *Model) animate() tea.Cmd {
	var cmds []tea.Cmd
	if (m.phase == connecting || m.phase == busy) && !m.spinning {
		m.spinning = true
		cmds = append(cmds, m.spin.Tick)
	}
	if m.landingVisible() && !m.animated {
		m.animated = true
		cmds = append(cmds, animTick())
	}
	if s, ok := m.activeWindow().(*showcaseApp); ok {
		cmds = append(cmds, s.wake()) // brought back to the front: moving again
	}
	return tea.Batch(cmds...)
}

// animTicked is one frame of the home screen's motion, or its end: off the home screen, or resting.
func (m *Model) animTicked() tea.Cmd {
	now := time.Now()
	if !m.landingVisible() || m.resting(now) {
		m.animated = false
		return nil
	}
	m.angle += 0.06
	if m.opts.Motion {
		m.homeT += animInterval.Seconds()
		m.stepTourDrawer()
	}
	m.turnPhoto(now)
	return animTick()
}

// wake starts the motion again after input, once the message has been handled; nil otherwise.
func (m *Model) wake(woke bool) tea.Cmd {
	if !woke {
		return nil
	}
	return m.animate()
}

// restAfter is how long the home screen moves with no key or click before it rests.
const restAfter = time.Minute

// resting is whether motion should stop now.
func (m *Model) resting(now time.Time) bool {
	if m.notifier.blurred {
		return true
	}
	return !m.lastInput.IsZero() && now.Sub(m.lastInput) >= restAfter
}

// noteActivity records a key, a click, a paste or the terminal coming back into focus, and
// reports whether msg was one, so motion that rested can start again.
func (m *Model) noteActivity(msg tea.Msg, now time.Time) bool {
	switch msg.(type) {
	case tea.KeyPressMsg, tea.MouseMsg, tea.PasteMsg, tea.FocusMsg, tea.WindowSizeMsg:
		m.lastInput = now
		return true
	}
	if m.lastInput.IsZero() {
		m.lastInput = now // the clock starts when Friday does
	}
	return false
}
