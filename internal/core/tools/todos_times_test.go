package tools

import (
	"context"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
	"github.com/chrisnkuno/friday-cli/internal/core/worktime"
)

// TestPlanStepsAreTimedAndLearned: a step is timed from its start, or, done without one, from the
// step done before it; finished steps are learned for the project, and every result says what a
// step is expected to take and when the step in progress began.
func TestPlanStepsAreTimedAndLearned(t *testing.T) {
	root := t.TempDir()
	w := NewWorkspace(root)
	clock := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	w.Todos.now = func() time.Time { return clock }
	write := w.todoWrite()
	call := func(args tool.Args) tool.Result {
		t.Helper()
		r := write.Run(context.Background(), tool.Context{}, args)
		if r.IsError {
			t.Fatalf("%v: %s", args, r.Content)
		}
		return r
	}

	r := call(tool.Args{"items": []any{"read", "change", "test"}})
	plan, ok := r.Data["plan"].(worktime.Estimate)
	if !ok || plan.Basis != "guess" || !(plan.P90 > plan.P50) {
		t.Fatalf("a new plan says what a step should take: %#v", r.Data["plan"])
	}

	clock = clock.Add(2 * time.Minute) // step 1 was worked on without being started
	call(tool.Args{"complete": []any{1.0}})
	r = call(tool.Args{"start": []any{2.0}})
	var started time.Time
	for _, it := range r.Data["items"].([]TodoItem) {
		if it.ID == 2 {
			started = it.Started
		}
	}
	if !started.Equal(clock) {
		t.Fatalf("the step in progress says when it began: %v, want %v", started, clock)
	}
	clock = clock.Add(4 * time.Minute)
	call(tool.Args{"complete": []any{2.0}})

	learned := worktime.For(root).PlanStep()
	if learned.Basis != "history" || learned.Runs != 2 {
		t.Fatalf("two steps (2 and 4 minutes) learned: %+v", learned)
	}
	if learned.P50 < 120 || learned.P50 > 240 {
		t.Errorf("their median lies between them: %v s", learned.P50)
	}

	// Marking a done step done again teaches nothing.
	clock = clock.Add(time.Hour)
	call(tool.Args{"complete": []any{2.0}})
	if again := worktime.For(root).PlanStep(); again.Runs != 2 {
		t.Errorf("a repeated completion was learned: %+v", again)
	}
}
