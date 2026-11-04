package agents

import (
	"math"
	"testing"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
	"github.com/chrisnkuno/friday-cli/internal/core/worktime"
)

// TestASessionLearnsFromThePastHelpersOfItsProject: the first session of a version that learns helper
// times reads the helpers earlier sessions ran: finished ones, by their start and their last word,
// with their model calls as steps; failed ones, and ones resumed after a restart, are left out.
func TestASessionLearnsFromThePastHelpersOfItsProject(t *testing.T) {
	root := t.TempDir()
	past, err := thread.Create(root, thread.Meta{ID: thread.NewID(time.Now().Add(-time.Hour)), Cwd: root})
	if err != nil {
		t.Fatal(err)
	}
	answer := fantasy.Message{Role: fantasy.MessageRoleAssistant, Content: []fantasy.MessagePart{fantasy.TextPart{Text: "x"}}}
	spawn := func(id, role string, ago time.Duration, statuses ...string) {
		t.Helper()
		if err := past.Spawn(thread.Thread{ID: id, Parent: thread.Root, Role: role, CreatedAt: time.Now().Add(-ago)}); err != nil {
			t.Fatal(err)
		}
		_ = past.SaveMessages(id, []fantasy.Message{answer, answer, answer, answer})
		for _, st := range statuses {
			_ = past.SetStatus(id, st, "")
		}
	}
	spawn("t-done01", "explore", 40*time.Second, thread.Done)
	spawn("t-fail01", "explore", 10*time.Second, thread.Failed)
	spawn("t-back01", "general", 3*time.Minute, thread.Interrupted, thread.Done)

	h := newHarness(t, root, policy.Build, func(string, fantasy.Call) reply { return reply{text: "x"} })
	h.create()
	book := worktime.For(root)
	deadline := time.Now().Add(3 * time.Second)
	for book.Helper("explore", 10).Basis != "history" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	e := book.Helper("explore", 10)
	if e.Basis != "history" || e.Runs != 1 || e.P50 < 35 || e.P50 > 45 || !near(e.StepP50, 10, 0.15) {
		t.Fatalf("the finished explore run (40 s, 4 steps) only: %+v", e)
	}
	if g := book.Helper("general", 25); g.Basis == "history" {
		t.Errorf("a run resumed after a restart was learned: %+v", g)
	}
}

func near(a, b, tolerance float64) bool { return math.Abs(a-b) <= tolerance*math.Abs(b) }
