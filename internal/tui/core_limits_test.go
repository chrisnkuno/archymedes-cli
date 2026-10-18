package tui

import (
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)

func TestAQuietSessionForecastsNothing(t *testing.T) {
	var l limitTracker
	l.free = true
	for i := range 3 {
		l.call(t0.Add(time.Duration(i) * 15 * time.Second))
	}
	f := l.predict(t0.Add(50 * time.Second))
	if f.Level != levelCalm || f.Reason != "" || f.Risk >= 0.35 {
		t.Fatalf("%+v", f)
	}
}

func TestARapidPaceApproachesTheMinuteCap(t *testing.T) {
	var l limitTracker
	l.free = true
	for i := range 16 {
		l.call(t0.Add(time.Duration(i) * 3 * time.Second))
	}
	f := l.predict(t0.Add(50 * time.Second))
	if f.Level < levelHigh || f.InMinute != 16 || f.Cap != freeMinuteCap {
		t.Fatalf("16 requests against a cap of 20 should be high: %+v", f)
	}
}

func TestFailedToolCallsRaiseTheForecastBecauseEachCostsAnotherRequest(t *testing.T) {
	var clean, flailing limitTracker
	clean.free, flailing.free = true, true
	for i := range 8 {
		at := t0.Add(time.Duration(i) * 5 * time.Second)
		clean.call(at)
		flailing.call(at)
		flailing.toolError(at)
	}
	now := t0.Add(45 * time.Second)
	a, b := clean.predict(now), flailing.predict(now)
	if b.Risk <= a.Risk+0.15 {
		t.Fatalf("clean %.2f, flailing %.2f", a.Risk, b.Risk)
	}
	if !strings.Contains(b.Reason, "failed tool calls") {
		t.Fatalf("reason %q", b.Reason)
	}
}

func TestADailyBudgetRunningOutIsForecastFromThePace(t *testing.T) {
	var l limitTracker
	l.allowance(30, 1000)
	for i := range 6 {
		l.call(t0.Add(time.Duration(i) * 8 * time.Second))
	}
	f := l.predict(t0.Add(50 * time.Second))
	if f.Exhausted <= 0 || f.Exhausted > 10*time.Minute || f.Level < levelHigh || !strings.Contains(f.Reason, "30 of 1000") {
		t.Fatalf("%+v", f)
	}
	l.allowance(0, 1000)
	if got := l.predict(t0.Add(50 * time.Second)); got.Level != levelLimited {
		t.Fatalf("an empty budget is a limit: %+v", got)
	}
}

func TestARecentRefusalFadesOverFiveMinutes(t *testing.T) {
	var l limitTracker
	l.rateLimited(t0)
	soon, later, gone := l.predict(t0.Add(10*time.Second)), l.predict(t0.Add(3*time.Minute)), l.predict(t0.Add(6*time.Minute))
	if !(soon.Risk > later.Risk && later.Risk > gone.Risk) || gone.Risk != 0 {
		t.Fatalf("soon %.2f later %.2f gone %.2f", soon.Risk, later.Risk, gone.Risk)
	}
	if !strings.Contains(soon.Reason, "refused recently") {
		t.Fatal(soon.Reason)
	}
}

func TestTheTrackerForgetsWhatNoLongerCounts(t *testing.T) {
	var l limitTracker
	for i := range 100 {
		l.call(t0.Add(time.Duration(i) * time.Second))
	}
	l.predict(t0.Add(10 * time.Minute))
	if len(l.calls) != 0 {
		t.Fatalf("%d calls kept", len(l.calls))
	}
}

func TestTheGaugeAppearsInTheTrayOnlyWhenThereIsSomethingToSay(t *testing.T) {
	m, _ := unconfigured(t)
	m.overlay = nil
	m.session.Info.Provider = "free"
	m.limitTicked()
	if strings.Contains(m.tray(), "calm") || m.gauge() != "" {
		t.Fatalf("a quiet session shows no gauge: %q", m.gauge())
	}
	now := time.Now()
	for i := range 18 {
		m.limits.call(now.Add(-time.Duration(i) * time.Second))
	}
	run(m, m.limitTicked())
	m.limitBar.SetPercent(m.forecast.Risk)
	if m.forecast.Level < levelHigh {
		t.Fatalf("%+v", m.forecast)
	}
	if !strings.Contains(m.gauge(), m.forecast.Level.String()) {
		t.Fatalf("gauge %q", m.gauge())
	}
	if len(m.toasts) == 0 || !strings.Contains(m.toasts[len(m.toasts)-1].text, "Rate-limit risk") {
		t.Fatalf("a climb into high should say so: %+v", m.toasts)
	}
	if !strings.Contains(m.limitDetail(), "18/20 per minute") {
		t.Fatal(m.limitDetail())
	}
}
