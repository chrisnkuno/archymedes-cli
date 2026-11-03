package tui

import (
	"fmt"
	"math"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// A test run as its card shows it: how long the engine expects it to take before it starts (from
// this project's earlier runs, or a guess from its test files), whether a long whole-suite run can
// wait for the end of the work, and afterwards how long it took, or that it was answered from an
// earlier pass because nothing had changed. The engine sends it as `testRun` in the call's data.

type testRun struct {
	p50, p90    float64 // seconds
	basis       string  // history, parts, similar, guess
	runs        int
	canWait     bool
	narrower    string
	narrowerP50 float64
	took        float64 // seconds, once finished
	finished    bool
	reused      bool
	saved       float64 // seconds a reused pass saved
}

// readTestRun is a call's `testRun`, or nil when the call runs no tests. A result's fields are
// laid over what its call said.
func readTestRun(data map[string]any, onto *testRun) *testRun {
	raw, ok := data["testRun"].(map[string]any)
	if !ok {
		return onto
	}
	tr := &testRun{}
	if onto != nil {
		*tr = *onto
	}
	num := func(key string) (float64, bool) {
		v, ok := raw[key].(float64)
		return v, ok
	}
	if v, ok := num("p50"); ok {
		tr.p50 = v
	}
	if v, ok := num("p90"); ok {
		tr.p90 = v
	}
	if v, ok := num("runs"); ok {
		tr.runs = int(v)
	}
	if v, ok := raw["basis"].(string); ok {
		tr.basis = v
	}
	tr.canWait, _ = raw["canWait"].(bool)
	tr.narrower, _ = raw["narrower"].(string)
	tr.narrowerP50, _ = num("narrowerP50")
	if v, ok := num("took"); ok {
		tr.took, tr.finished = v, true
	}
	tr.reused, _ = raw["reused"].(bool)
	tr.saved, _ = num("saved")
	return tr
}

// expected is the estimate in words: "≈45s", "≈45s–1m 10s" when the spread is wide, with "guess"
// when nothing was measured.
func (tr *testRun) expected() string {
	text := "≈" + shortDuration(tr.p50)
	if tr.p90 > tr.p50*1.6 && shortDuration(tr.p90) != shortDuration(tr.p50) {
		text += "–" + shortDuration(tr.p90)
	}
	if tr.basis == "guess" {
		text += " (guess)"
	}
	return text
}

// cardNote is what the card's header adds after its summary.
func (tr *testRun) cardNote(th theme.Theme) string {
	if tr == nil {
		return ""
	}
	if tr.reused {
		return th.Faint.Render(" · already passed · " + shortDuration(tr.saved) + " saved")
	}
	if tr.finished {
		return th.Faint.Render(" · " + shortDuration(tr.took))
	}
	note := th.Faint.Render(" · " + tr.expected())
	if tr.canWait {
		note += th.Warn.Render(" · can wait for the end")
	}
	return note
}

// railNote is a running test's time against what it should take: "12s of ≈45s".
func (tr *testRun) railNote(running time.Duration) string {
	if tr == nil || tr.finished {
		return ""
	}
	note := " of " + tr.expected()
	if over := running.Seconds() - tr.p90; tr.p90 > 0 && over > 0 {
		note += " · slower than usual"
	}
	return note
}

// shortDuration is seconds on a card: "800ms", "12s", "1m 40s".
func shortDuration(seconds float64) string {
	switch {
	case seconds < 1:
		return fmt.Sprintf("%dms", int(math.Round(seconds*1000)))
	case seconds < 60:
		return fmt.Sprintf("%ds", int(math.Round(seconds)))
	case seconds < 3600:
		m, s := int(seconds)/60, int(math.Round(seconds))%60
		if s == 0 {
			return fmt.Sprintf("%dm", m)
		}
		return fmt.Sprintf("%dm %ds", m, s)
	}
	return fmt.Sprintf("%dh %dm", int(seconds)/3600, int(seconds)%3600/60)
}
