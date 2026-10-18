package tui

import (
	"fmt"
	"math"
	"time"

	"charm.land/bubbles/v2/progress"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// Rate-limit forecasting. A free model's limit is not a surprise so much as arithmetic nobody did: a
// per-minute cap, a daily budget, and an agent that — when its tool calls keep failing — spends
// requests faster the worse it is going. The tracker watches what the interface already receives
// (each model call, each failed tool call, each 429, the provider's reported allowance) and says how
// close the next request is to being refused, before it is.

const (
	// freeMinuteCap is the per-minute request ceiling free endpoints commonly enforce.
	freeMinuteCap = 20
	// otherMinuteCap is a loose ceiling for providers that publish none: only 429s move the needle.
	otherMinuteCap = 60
	callWindow     = time.Minute
	errorWindow    = 90 * time.Second
	rateWindow     = 5 * time.Minute
)

type limitTracker struct {
	calls, errors, rates []time.Time
	remaining, limit     int // the provider's daily allowance; limit 0 until one is reported
	free                 bool
}

func (t *limitTracker) call(at time.Time)        { t.calls = append(t.calls, at) }
func (t *limitTracker) toolError(at time.Time)   { t.errors = append(t.errors, at) }
func (t *limitTracker) rateLimited(at time.Time) { t.rates = append(t.rates, at) }

func (t *limitTracker) allowance(remaining, limit int) {
	if limit > 0 {
		t.remaining, t.limit = remaining, limit
	}
}

// trim forgets what no longer counts, so the slices stay small however long the session runs.
func trim(times []time.Time, now time.Time, window time.Duration) []time.Time {
	keep := times[:0]
	for _, at := range times {
		if now.Sub(at) < window {
			keep = append(keep, at)
		}
	}
	return keep
}

type limitLevel int

const (
	levelCalm limitLevel = iota
	levelBusy
	levelHigh
	levelLimited
)

func (l limitLevel) String() string {
	return [...]string{"calm", "busy", "high", "limit"}[l]
}

// forecast is the answer: how likely the next request is to be refused, and why.
type forecast struct {
	Risk   float64 // 0 (clear) to 1 (about to be refused)
	Level  limitLevel
	Reason string
	// InMinute is requests sent in the last minute; Cap the ceiling they are measured against.
	InMinute, Cap int
	// Exhausted is when the daily budget runs out at the current pace; zero when unknown or distant.
	Exhausted time.Duration
}

// predict combines four pressures and takes the worst, then adds recent refusals on top:
//   - the minute: requests in the last minute against the cap, with each recent failed tool call
//     counted as half a request still to come (a failing call is followed by another attempt);
//   - the day: the time until the allowance runs out at the current pace;
//   - refusals: a 429 in the last five minutes, fading, is the best predictor of the next one.
func (t *limitTracker) predict(now time.Time) forecast {
	t.calls, t.errors, t.rates = trim(t.calls, now, callWindow), trim(t.errors, now, errorWindow), trim(t.rates, now, rateWindow)
	capacity := otherMinuteCap
	if t.free || t.limit > 0 {
		capacity = freeMinuteCap
	}
	f := forecast{InMinute: len(t.calls), Cap: capacity}

	minute := (float64(len(t.calls)) + 0.5*float64(len(t.errors))) / float64(capacity)
	f.Risk, f.Reason = minute, fmt.Sprintf("%d requests in the last minute, %d failed tool calls", len(t.calls), len(t.errors))
	if len(t.errors) >= 3 && len(t.errors) > len(t.calls)/2 {
		f.Reason = fmt.Sprintf("%d failed tool calls: each one costs another request", len(t.errors))
	}

	if t.limit > 0 {
		share := float64(t.remaining) / float64(t.limit)
		day := 0.0
		if perMinute := float64(len(t.calls)); perMinute > 0 && t.remaining > 0 {
			f.Exhausted = time.Duration(float64(t.remaining) / perMinute * float64(time.Minute))
			// An hour of headroom is none of a worry; ten minutes is nearly out.
			day = clamp01(1 - f.Exhausted.Minutes()/60)
		}
		if share < 0.05 {
			day = math.Max(day, 0.85)
		}
		if t.remaining <= 0 {
			day = 1
		}
		if day > f.Risk {
			f.Risk = day
			f.Reason = fmt.Sprintf("%d of %d daily requests left", t.remaining, t.limit)
			if f.Exhausted > 0 && f.Exhausted < time.Hour {
				f.Reason += fmt.Sprintf(", gone in ~%s at this pace", elapsed(f.Exhausted.Round(time.Second)))
			}
		}
	}

	for _, at := range t.rates {
		fade := 1 - now.Sub(at).Seconds()/rateWindow.Seconds()
		f.Risk += 0.5 * fade
		f.Reason = "refused recently — limits are likely still active"
	}

	f.Risk = clamp01(f.Risk)
	switch {
	case f.Risk >= 0.85:
		f.Level = levelLimited
	case f.Risk >= 0.6:
		f.Level = levelHigh
	case f.Risk >= 0.35:
		f.Level = levelBusy
	}
	if f.Level == levelCalm {
		f.Reason = ""
	}
	return f
}

func clamp01(v float64) float64 { return math.Min(math.Max(v, 0), 1) }

// --- the gauge ---

type limitTickMsg struct{}

const limitTickEvery = time.Second

func limitTick() tea.Cmd {
	return tea.Tick(limitTickEvery, func(time.Time) tea.Msg { return limitTickMsg{} })
}

// newLimitBar is a short bar that fills, on a spring, as the forecast rises: green to amber to red
// along its length, so how full it is and how bad it is read as one thing.
func newLimitBar(m *Model) progress.Model {
	bar := progress.New(
		progress.WithColors(m.th.Success, m.th.Warning, m.th.Error),
		progress.WithWidth(8),
		progress.WithoutPercentage(),
		progress.WithFillCharacters('█', '░'),
		progress.WithSpringOptions(8, 0.8),
	)
	return bar
}

// limitTicked recomputes the forecast, moves the bar toward it, and — once per climb into "high" —
// says so in words, with what helps.
func (m *Model) limitTicked() tea.Cmd {
	m.limits.free = m.session.Info.Provider == "free"
	f := m.limits.predict(time.Now())
	cmds := []tea.Cmd{limitTick()}
	if math.Abs(f.Risk-m.limitBar.Percent()) > 0.02 {
		cmds = append(cmds, m.limitBar.SetPercent(f.Risk))
	}
	if f.Level >= levelHigh && m.lastLevel < levelHigh && time.Since(m.limitWarned) > time.Minute {
		m.limitWarned = time.Now()
		advice := "Slow down or switch with /model"
		if f.Level == levelLimited {
			advice = "A refusal is imminent: let it breathe, or switch with /model"
		}
		cmds = append(cmds, m.toast(toastWarn, fmt.Sprintf("Rate-limit risk: %s — %s. %s", f.Level, f.Reason, advice)))
	}
	m.lastLevel, m.forecast = f.Level, f
	return tea.Batch(cmds...)
}

// gauge is the tray's piece: the bar and its word, shown only once there is something to say.
func (m *Model) gauge() string {
	f := m.forecast
	if f.Risk < 0.2 && m.limitBar.Percent() < 0.2 {
		return ""
	}
	th := m.th
	style := th.OK
	switch f.Level {
	case levelBusy:
		style = th.Highlight
	case levelHigh:
		style = th.Warn
	case levelLimited:
		style = th.Bad
	}
	return m.limitBar.View() + " " + lipgloss.NewStyle().Inherit(style).Render(f.Level.String()) + " "
}

// limitDetail is the Tasks app's line about the forecast.
func (m *Model) limitDetail() string {
	f := m.forecast
	line := fmt.Sprintf("requests %d/%d per minute", f.InMinute, f.Cap)
	if m.limits.limit > 0 {
		line += fmt.Sprintf(" · %d/%d today", m.limits.remaining, m.limits.limit)
	}
	line += " · forecast " + f.Level.String()
	if f.Reason != "" {
		line += " — " + f.Reason
	}
	return line
}
