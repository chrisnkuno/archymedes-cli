package tui

import (
	"fmt"
	"math"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// How long work has left: a helper at work, and the agent's plan. The engine learns how long a
// helper of each role, and a plan step, takes in this project (core/worktime) and sends it as a
// log-normal time: its median P50 and 90th percentile P90. What is left of a run that has gone on
// for t seconds is not P50 − t: a run still going at t is one of the longer ones. So the whole run
// is taken as the median of the times longer than t,
//
//	q = exp(μ + σ·√2·erfcinv(S(t))),  S(t) = ½·erfc((ln t − μ) / (σ√2)),
//
// with μ = ln P50 and σ = ln(P90/P50) / z90; at t = 0 that is P50, and it grows with t. A helper
// also stops at its step limit, so what is left is at most its steps to go times its own pace so far
// (the engine's median step time before its first step).

const z90 = 1.2816 // the standard normal's 90th percentile

// timeLeft is about how many seconds a run expected as e has left after elapsed seconds and turns
// of its maxSteps (0: no limit known). ok is false when e cannot be used.
func timeLeft(e *acp.WorkEstimate, elapsed float64, turns, maxSteps int) (left float64, ok bool) {
	if e == nil || !(e.P50 > 0) || !(e.P90 > e.P50) || math.IsInf(e.P90, 0) {
		return 0, false
	}
	mu, sigma := math.Log(e.P50), math.Log(e.P90/e.P50)/z90
	survive := 1.0
	if elapsed > 0 {
		survive = 0.5 * math.Erfc((math.Log(elapsed)-mu)/(sigma*math.Sqrt2))
	}
	left = math.Inf(1)
	if survive > 0 {
		left = max(math.Exp(mu+sigma*math.Sqrt2*math.Erfcinv(survive))-elapsed, 0)
	}
	if maxSteps > 0 {
		togo := maxSteps - turns
		if togo <= 0 {
			return 0, true
		}
		pace := e.StepP50
		if turns > 0 && elapsed > 0 {
			pace = elapsed / float64(turns)
		}
		if pace > 0 {
			left = min(left, float64(togo)*pace)
		}
	}
	if math.IsInf(left, 0) || math.IsNaN(left) {
		return 0, false
	}
	return left, true
}

// meanTime is the mean of a log-normal time: what a step adds, on average, to a sum of steps.
func meanTime(e *acp.WorkEstimate) float64 {
	sigma := math.Log(e.P90/e.P50) / z90
	return e.P50 * math.Exp(sigma*sigma/2)
}

// approx is a time left in words: "≈40s", "≈3m", "≈1h 10m".
func approx(seconds float64) string {
	switch {
	case seconds < 60:
		return fmt.Sprintf("≈%ds", max(5, int(math.Round(seconds/5))*5))
	case seconds < 3600:
		return fmt.Sprintf("≈%dm", int(math.Round(seconds/60)))
	}
	return fmt.Sprintf("≈%dh %dm", int(seconds)/3600, int(seconds)%3600/60)
}

// helperTiming is a helper's time in words: "1m 12s · ≈2m left", or "· longer than usual" once it
// is past the time nine in ten of its kind take; "" before it has a start.
func helperTiming(s *subagentRun, now time.Time) string {
	if s == nil || s.started.IsZero() {
		return ""
	}
	ran := now.Sub(s.started)
	text := shortDuration(ran.Seconds())
	switch left, ok := timeLeft(s.estimate, ran.Seconds(), s.turns, s.maxSteps); {
	case ok && ran.Seconds() > s.estimate.P90:
		text += " · longer than usual"
	case ok:
		text += " · " + approx(left) + " left"
	}
	return text
}

// helpersLeft is the helpers at work and about how long until the last of them is done.
func (m *Model) helpersLeft(now time.Time) (n int, longest float64, known bool) {
	for _, t := range m.workingAgents() {
		n++
		if t.sub == nil || t.sub.started.IsZero() {
			continue
		}
		ran := now.Sub(t.sub.started).Seconds()
		if left, ok := timeLeft(t.sub.estimate, ran, t.sub.turns, t.sub.maxSteps); ok {
			longest, known = max(longest, left), true
		}
	}
	return n, longest, known
}

// helpersChip is the top bar's count of helpers at work, with the time until the last is done,
// when the rail is not beside the transcript to list them; a click opens the Inspector.
func (m *Model) helpersChip() string {
	if m.railWidth() > 0 || m.landingVisible() {
		return ""
	}
	n, longest, known := m.helpersLeft(time.Now())
	if n == 0 {
		return ""
	}
	text := plural(n, "helper")
	if known {
		text += " " + approx(longest) + " left"
	}
	return mark(m.zones.frame, "helpers-chip", m.th.Faint.Render(text)) + " "
}

// helpersChipClick opens the Inspector, on every helper, from the top bar's chip.
func (m *Model) helpersChipClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	if !m.zones.frame.Get("helpers-chip").InBounds(msg) {
		return nil, false
	}
	return m.openInspector(nil), true
}
