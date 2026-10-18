package tui

import (
	"math"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/harmonica"
)

// Scrolling that moves rather than jumps: a page, a wheel notch or "back to live" glides to its
// place on a critically damped spring (Harmonica) — quick, no overshoot, settled in about a quarter
// of a second. The transcript's scroll offset stays the single truth; this only walks it toward a
// target, frame by frame, and the tick runs only while it moves. With motion off (Options.Motion
// false, as under ARCHYMEDES_REDUCE_MOTION=1 or in tests) every move is immediate.

const scrollFPS = 60

type scrollTickMsg struct{}

type scroller struct {
	spring   harmonica.Spring
	pos, vel float64
	target   int
	active   bool
}

func newScroller() scroller {
	return scroller{spring: harmonica.NewSpring(harmonica.FPS(scrollFPS), 20.0, 1.0)}
}

// scrollTarget is where the view is headed: the spring's target while it moves, else where it is.
func (m *Model) scrollTarget() int {
	if m.scroll.active {
		return m.scroll.target
	}
	return m.tr.scroll
}

// scrollTo moves the view to target lines above the newest line (0 is live).
func (m *Model) scrollTo(target int) tea.Cmd {
	target = max(target, 0)
	if !m.opts.Motion {
		m.tr.scroll = target
		return nil
	}
	s := &m.scroll
	if !s.active {
		s.pos, s.vel = float64(m.tr.scroll), 0
	}
	s.target = target
	if s.active {
		return nil // already ticking toward the old target; it now heads for this one
	}
	s.active = true
	return scrollTick()
}

func (m *Model) scrollBy(delta int) tea.Cmd { return m.scrollTo(m.scrollTarget() + delta) }

func scrollTick() tea.Cmd {
	return tea.Tick(time.Second/scrollFPS, func(time.Time) tea.Msg { return scrollTickMsg{} })
}

func (m *Model) stepScroll() tea.Cmd {
	s := &m.scroll
	if !s.active {
		return nil
	}
	s.pos, s.vel = s.spring.Update(s.pos, s.vel, float64(s.target))
	// Critically damped, so it cannot overshoot: within half a line, what is left is invisible.
	if math.Abs(s.pos-float64(s.target)) < 0.5 {
		m.tr.scroll, s.active = s.target, false
		return nil
	}
	m.tr.scroll = max(int(math.Round(s.pos)), 0)
	return scrollTick()
}

// stopScroll ends any glide where it is; a jump (to the top, to new output) wins over it.
func (m *Model) stopScroll() { m.scroll.active = false }
