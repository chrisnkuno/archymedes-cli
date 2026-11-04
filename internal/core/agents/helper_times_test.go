package agents

import (
	"testing"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/worktime"
)

// TestAHelperSaysHowLongItShouldTakeAndIsLearned: the thread notice that starts a helper carries
// when it started, its step limit and its expected time; a finished helper's time is learned, so
// the next one of its role is estimated from history.
func TestAHelperSaysHowLongItShouldTakeAndIsLearned(t *testing.T) {
	root := t.TempDir()
	h := newHarness(t, root, policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			time.Sleep(1100 * time.Millisecond) // a run under a second is not learned
			return reply{text: "found it"}
		}
		if role, _ := lastOf(call); role == fantasy.MessageRoleUser {
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"where is Foo?"}`}}}
		}
		return reply{text: "done"}
	})
	s := h.create()
	before := time.Now()
	h.prompt(s, "find Foo")

	notices := h.of("thread")
	if len(notices) != 2 {
		t.Fatalf("thread notices: %d", len(notices))
	}
	start := notices[0].Thread
	if start.Status != "running" || start.Estimate == nil || start.Estimate.Basis != "guess" || !(start.Estimate.P90 > start.Estimate.P50) {
		t.Fatalf("the start says what to expect: %+v (estimate %+v)", start, start.Estimate)
	}
	if start.MaxSteps <= 0 || start.StartedAt.Before(before.Add(-time.Second)) || start.StartedAt.After(time.Now()) {
		t.Fatalf("started at %v, step limit %d", start.StartedAt, start.MaxSteps)
	}
	if end := notices[1].Thread; end.Estimate == nil || !end.StartedAt.Equal(start.StartedAt) {
		t.Fatalf("the end keeps the start and the estimate: %+v", end)
	}
	if e := worktime.For(root).Helper(start.Agent, start.MaxSteps); e.Basis != "history" || e.Runs != 1 || e.P50 < 1 {
		t.Fatalf("the finished run was not learned: %+v", e)
	}
}
