package worktime

import (
	"math"
	"os"
	"testing"
	"time"
)

func near(a, b, tolerance float64) bool {
	return math.Abs(a-b) <= tolerance*math.Max(math.Abs(b), 1e-9)
}

// TestAHelperWithNoHistoryIsAGuessFromItsStepLimit: a guess scales with how many steps the role
// may take, says it is a guess, and keeps P90 above P50.
func TestAHelperWithNoHistoryIsAGuessFromItsStepLimit(t *testing.T) {
	b := For(t.TempDir())
	small, big := b.Helper("explore", 10), b.Helper("general", 25)
	if small.Basis != "guess" || small.Runs != 0 {
		t.Fatalf("no history: %+v", small)
	}
	if !(big.P50 > small.P50) || !near(big.P50/small.P50, 2.5, 0.01) {
		t.Errorf("a role allowed 25 steps vs 10: %v vs %v", big.P50, small.P50)
	}
	for _, e := range []Estimate{small, big, b.Helper("odd", 0)} {
		if !(e.P50 > 0) || !(e.P90 > e.P50) || !(e.StepP50 > 0) {
			t.Errorf("invariant: 0 < P50 < P90, a step time: %+v", e)
		}
	}
}

// TestAHelperLearnsItsRolesTimes: after runs, the estimate is this role's, centred on what the runs
// took, and other roles borrow this project's step time.
func TestAHelperLearnsItsRolesTimes(t *testing.T) {
	root := t.TempDir()
	b := For(root)
	for _, secs := range []float64{40, 60, 50, 45, 55} {
		b.RecordHelper("explore", time.Duration(secs*float64(time.Second)), 5)
	}
	e := b.Helper("explore", 10)
	if e.Basis != "history" || e.Runs != 5 {
		t.Fatalf("after five runs: %+v", e)
	}
	if e.P50 < 40 || e.P50 > 60 || !near(e.StepP50, e.P50/5, 0.25) {
		t.Errorf("centred on 40–60 s, ten seconds a step: %+v", e)
	}
	other := b.Helper("general", 25)
	if other.Basis != "similar" || !near(other.StepP50, e.StepP50, 0.25) {
		t.Errorf("another role borrows the project's step time: %+v (explore %+v)", other, e)
	}

	// Kept on disk, under the project.
	if _, err := os.Stat(Path(root)); err != nil {
		t.Fatal(err)
	}
	again := (&Book{path: Path(root)}).Helper("explore", 10)
	if again.Basis != "history" || again.Runs != 5 {
		t.Errorf("read back: %+v", again)
	}
}

// TestPlanStepsLearnToo: a plan step is guessed, then measured.
func TestPlanStepsLearnToo(t *testing.T) {
	b := For(t.TempDir())
	if g := b.PlanStep(); g.Basis != "guess" || !(g.P90 > g.P50) {
		t.Fatalf("guess: %+v", g)
	}
	for range 4 {
		b.RecordPlanStep(3 * time.Minute)
	}
	if e := b.PlanStep(); e.Basis != "history" || !near(e.P50, 180, 0.05) {
		t.Errorf("four three-minute steps: %+v", e)
	}
}

// TestNonsenseIsNotLearned: no time, or a time under a second, is not a run.
func TestNonsenseIsNotLearned(t *testing.T) {
	b := For(t.TempDir())
	b.RecordHelper("explore", 0, 3)
	b.RecordHelper("explore", 200*time.Millisecond, 0)
	b.RecordPlanStep(-time.Second)
	if e := b.Helper("explore", 10); e.Basis != "guess" {
		t.Errorf("learned from nonsense: %+v", e)
	}
	if e := b.PlanStep(); e.Basis != "guess" {
		t.Errorf("learned a negative plan step: %+v", e)
	}
}

// TestBackfillSeedsAProjectOnce: the runs a project already has are learned once, sensible ones
// only, and a second backfill does not even look.
func TestBackfillSeedsAProjectOnce(t *testing.T) {
	root := t.TempDir()
	b := For(root)
	asked := 0
	runs := func() []Run {
		asked++
		return []Run{
			{Role: "explore", Took: 40 * time.Second, Steps: 4},
			{Role: "explore", Took: 60 * time.Second, Steps: 6},
			{Role: "explore", Took: 300 * time.Millisecond, Steps: 1}, // under a second
			{Role: "general", Took: 5 * time.Hour, Steps: 20},         // left open, not worked on
		}
	}
	if !b.Backfill(runs) {
		t.Fatal("a fresh project was not backfilled")
	}
	if e := b.Helper("explore", 10); e.Basis != "history" || e.Runs != 2 || !near(e.StepP50, 10, 0.05) {
		t.Fatalf("two explore runs at ten seconds a step: %+v", e)
	}
	if e := b.Helper("general", 25); e.Basis == "history" {
		t.Errorf("a five-hour run was learned: %+v", e)
	}
	if b.Backfill(runs) || asked != 1 {
		t.Errorf("backfilled twice (asked %d times)", asked)
	}
	if (&Book{path: Path(root)}).Backfill(runs) || asked != 1 {
		t.Error("a restart backfilled again: seeded is not kept on disk")
	}
}
