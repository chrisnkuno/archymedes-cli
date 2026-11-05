package tui

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// When a plan's limit resets is shown beside the context gauge once it matters, so nobody plans
// their day around a limit they cannot see.

func TestPlanGaugeSaysHowMuchIsUsedAndWhenItResets(t *testing.T) {
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.Local)
	at := func(d time.Duration) int64 { return now.Add(d).Unix() }
	cases := []struct {
		name  string
		limit *acp.PlanLimit
		want  string
		warn  bool
	}{
		{"none reported", nil, "", false},
		{"low use says nothing", &acp.PlanLimit{Kind: "five_hour", Status: "allowed", Utilization: 0.3, ResetsAt: at(time.Hour)}, "", false},
		{"half used", &acp.PlanLimit{Kind: "five_hour", Status: "allowed", Utilization: 0.5, ResetsAt: at(90 * time.Minute)}, "5h 50% · resets 11:30", false},
		{"warning", &acp.PlanLimit{Kind: "five_hour", Status: "allowed_warning", Utilization: 0.91, ResetsAt: at(2 * time.Hour)}, "5h 91% · resets 12:00", true},
		{"used up, weekly, days away", &acp.PlanLimit{Kind: "seven_day_opus", Status: "rejected", Utilization: 1, ResetsAt: at(50 * time.Hour)}, "week 100% · resets Sun 12:00", true},
		{"used up with no use figure", &acp.PlanLimit{Kind: "five_hour", Status: "rejected", ResetsAt: at(time.Hour)}, "5h used up · resets 11:00", true},
		{"reset already passed", &acp.PlanLimit{Kind: "five_hour", Status: "allowed_warning", Utilization: 0.95, ResetsAt: at(-time.Minute)}, "", false},
		{"unknown reset time", &acp.PlanLimit{Kind: "five_hour", Status: "allowed_warning", Utilization: 0.8}, "5h 80%", true},
		{"silly utilization is clamped", &acp.PlanLimit{Kind: "other", Status: "allowed_warning", Utilization: 7, ResetsAt: at(time.Hour)}, "plan 100% · resets 11:00", true},
	}
	for _, c := range cases {
		text, warn := planGauge(c.limit, now)
		if text != c.want || warn != c.warn {
			t.Errorf("%s: got %q warn=%v, want %q warn=%v", c.name, text, warn, c.want, c.warn)
		}
	}
}

func TestDailyAllowanceSaysWhenItResets(t *testing.T) {
	m, _ := newTestModel(t)
	remaining, limit := 12, 50
	reset := time.Now().Add(3 * time.Hour).UTC().Truncate(time.Minute)
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "model_turn", Allowance: &acp.Allowance{RemainingRequests: &remaining, RequestLimit: &limit, ResetsAt: reset.Format(time.RFC3339)}}))
	want := "12/50 today, resets " + reset.Local().Format("15:04")
	if got := m.limitDetail(); !strings.Contains(got, want) {
		t.Fatalf("limit detail = %q, want it to contain %q", got, want)
	}
}

func TestThePlanLimitIsInTheTopBarBesideTheContextGauge(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 160, Height: 30})
	reset := time.Now().Add(90 * time.Minute)
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "model_turn", PlanLimit: &acp.PlanLimit{Kind: "five_hour", Status: "allowed_warning", Utilization: 0.84, ResetsAt: reset.Unix()}}))
	top := strings.Split(screen(m), "\n")[0]
	if !strings.Contains(top, "5h 84% · resets "+reset.Format("15:04")) {
		t.Fatalf("top bar lacks the plan limit:\n%s", top)
	}
}
