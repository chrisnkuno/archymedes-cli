package tui

import (
	"math"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// est is an estimate as the engine sends it: a helper of median p50 seconds, 90th percentile p90.
func est(p50, p90, step float64) *acp.WorkEstimate {
	return &acp.WorkEstimate{P50: p50, P90: p90, Basis: "history", Runs: 5, StepP50: step}
}

// TestTimeLeftInvariants: never negative; at the start, the median; the longer a helper has run, the
// longer its whole run is expected to be (it is one of the long ones), never shorter than it has
// already run; and the steps it has left cap it.
func TestTimeLeftInvariants(t *testing.T) {
	e := est(60, 150, 6)
	if left, ok := timeLeft(e, 0, 0, 0); !ok || math.Abs(left-60) > 1 {
		t.Fatalf("at the start the time left is the median: %v %v", left, ok)
	}
	prevTotal := 0.0
	for _, elapsed := range []float64{0, 10, 30, 60, 120, 300, 900, 3600} {
		left, ok := timeLeft(e, elapsed, 0, 0)
		if !ok || left < 0 || math.IsNaN(left) || math.IsInf(left, 0) {
			t.Fatalf("elapsed %v: left %v ok %v", elapsed, left, ok)
		}
		if total := elapsed + left; total+1e-9 < prevTotal {
			t.Errorf("elapsed %v: expected total %v fell below %v", elapsed, total, prevTotal)
		} else {
			prevTotal = total
		}
	}
	// 9 of 10 steps taken at 10 s each: one step, about 10 s, is left, whatever the history says.
	if left, _ := timeLeft(est(600, 1200, 60), 90, 9, 10); left > 10.5 {
		t.Errorf("one step left at 10 s a step: %v", left)
	}
	// Steps used up: nothing is left to estimate but its wrap-up.
	if left, ok := timeLeft(e, 100, 10, 10); !ok || left != 0 {
		t.Errorf("at its step limit: %v %v", left, ok)
	}
	for _, bad := range []*acp.WorkEstimate{nil, {P50: 0, P90: 10}, {P50: 10, P90: 5}, {P50: math.NaN(), P90: 1}} {
		if _, ok := timeLeft(bad, 10, 1, 10); ok {
			t.Errorf("an unusable estimate %+v gave a time", bad)
		}
	}
}

// TestBackgroundHelpersShowTheirTime: a helper at work shows how long it has run and about how long
// it has left, in the rail beside the conversation and, when the rail has no room, in the top bar;
// one past its usual time says so.
func TestBackgroundHelpersShowTheirTime(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 30})
	m.tr.add(&noticeItem{kind: noticeInfo, text: "conversation"})
	started := time.Now().Add(-30 * time.Second)
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"task": "port the parser", "agent": "general", "background": true}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "d1", ToolName: "delegate_task", Content: "started in the background"})
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "t1", ParentToolCallID: "d1", Agent: "general", Status: "running",
		Background: true, StartedAt: started, MaxSteps: 25, Estimate: est(120, 300, 8)}})

	s := screen(m)
	for _, want := range []string{"general", "background", "30s", "left"} {
		if !strings.Contains(s, want) {
			t.Errorf("the rail lacks %q:\n%s", want, s)
		}
	}

	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30}) // too narrow for the rail
	if m.railWidth() != 0 {
		t.Fatal("the rail still shows at 100 columns")
	}
	if top := strings.Split(screen(m), "\n")[0]; !strings.Contains(top, "1 helper") || !strings.Contains(top, "left") {
		t.Errorf("the top bar does not show the helper at work:\n%s", top)
	}

	// Past its usual time (its 90th percentile), it says it is running long rather than a time left.
	m.tools["d1"].sub.started = time.Now().Add(-10 * time.Minute)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 30})
	if s := screen(m); !strings.Contains(s, "longer than usual") {
		t.Errorf("a helper past its usual time is not marked:\n%s", s)
	}

	// Done, it leaves the top bar.
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "t1", ParentToolCallID: "d1", Agent: "general", Status: "done", Background: true, Report: "ported"}})
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	if top := strings.Split(screen(m), "\n")[0]; strings.Contains(top, "helper") {
		t.Errorf("a finished helper stays in the top bar:\n%s", top)
	}
}
