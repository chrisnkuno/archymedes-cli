package tools

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
	"github.com/chrisnkuno/friday-cli/internal/core/worktime"
)

// TodoItem is one line of the plan.
type TodoItem struct {
	ID     int    `json:"id"`
	Text   string `json:"text"`
	Status string `json:"status"` // pending | in_progress | done
	// Started is when the step went in progress, for the interface's time left (core/worktime).
	Started time.Time `json:"started,omitzero"`
}

// TodoList is the session's checklist (core/cli/tools.ts TodoList): replaced whole, updated by id
// in one call, unknown ids reported rather than failing the batch.
type TodoList struct {
	mu     sync.Mutex
	items  []TodoItem
	nextID int
	// mark is when the list was made or a step last finished: a step done without being started
	// is timed from there, the work between two completions being that step's.
	mark time.Time
	now  func() time.Time // the clock; nil is time.Now
}

func (l *TodoList) clock() time.Time {
	if l.now != nil {
		return l.now()
	}
	return time.Now()
}

// Replace sets a new list with fresh ids.
func (l *TodoList) Replace(texts []string) []TodoItem {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.items, l.mark = nil, l.clock()
	for _, text := range texts {
		l.nextID++
		l.items = append(l.items, TodoItem{ID: l.nextID, Text: text, Status: "pending"})
	}
	return slices.Clone(l.items)
}

// SetStatus applies every id that exists and returns the ones that do not, and how long each step
// it finished took: from its start, or from the step finished before it.
func (l *TodoList) SetStatus(ids []int, status string) (unknown []int, finished []time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	for _, id := range ids {
		found := false
		for i := range l.items {
			it := &l.items[i]
			if it.ID != id {
				continue
			}
			found = true
			switch {
			case status == "in_progress" && it.Status != "in_progress":
				it.Started = now
			case status == "done" && it.Status != "done":
				from := l.mark
				if !it.Started.IsZero() {
					from = it.Started
				}
				if !from.IsZero() {
					finished = append(finished, now.Sub(from))
				}
				l.mark = now
			}
			it.Status = status
		}
		if !found {
			unknown = append(unknown, id)
		}
	}
	return unknown, finished
}

// Items is a copy of the list.
func (l *TodoList) Items() []TodoItem {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.items)
}

func (l *TodoList) alreadyDone(ids []int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(ids) == 0 {
		return false
	}
	for _, id := range ids {
		ok := false
		for _, item := range l.items {
			if item.ID == id && item.Status == "done" {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

func renderTodos(items []TodoItem) string {
	if len(items) == 0 {
		return "No plan yet."
	}
	var b strings.Builder
	for _, item := range items {
		mark := "[ ]"
		switch item.Status {
		case "done":
			mark = "[x]"
		case "in_progress":
			mark = "[~]"
		}
		fmt.Fprintf(&b, "%s %d. %s\n", mark, item.ID, item.Text)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func ids(value any) []int {
	switch v := value.(type) {
	case float64:
		return []int{int(v)}
	case []any:
		var out []int
		for _, item := range v {
			if n, ok := item.(float64); ok {
				out = append(out, int(n))
			}
		}
		return out
	}
	return nil
}

func (w *Workspace) todoWrite() *tool.Tool {
	return &tool.Tool{
		Name:        "todo_write",
		Description: "Plan a multi-step task as a checklist and keep it current, batching updates into one call; skip it when nothing changed. `items` replaces the list with new ids — use ids from the latest todo_write/todo_read result only.",
		Schema: tool.ObjectSchema(map[string]any{
			"items":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"complete": map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": "Ids now done."},
			"start":    map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": "Ids now in progress."},
		}),
		Capability: tool.CapPlanning, Effect: tool.EffectNone,
		Run: func(_ context.Context, _ tool.Context, args tool.Args) tool.Result {
			if list, ok := args["items"].([]any); ok {
				var texts []string
				for i, item := range list {
					text, ok := item.(string)
					if !ok {
						return tool.Error(fmt.Sprintf("`items[%d]` must be a string", i))
					}
					texts = append(texts, text)
				}
				items := w.Todos.Replace(texts)
				return tool.Result{Content: renderTodos(items), Data: w.planData(items)}
			}
			complete, start := ids(args["complete"]), ids(args["start"])
			if len(complete) == 0 && len(start) == 0 {
				items := w.Todos.Items()
				return tool.Result{Content: renderTodos(items), Data: w.planData(items)}
			}
			redundant := len(start) == 0 && w.Todos.alreadyDone(complete)
			unknownStart, _ := w.Todos.SetStatus(start, "in_progress")
			unknownDone, finished := w.Todos.SetStatus(complete, "done")
			unknown := append(unknownStart, unknownDone...)
			for _, took := range finished {
				worktime.For(w.Root).RecordPlanStep(took)
			}
			items := w.Todos.Items()
			var note string
			if redundant {
				note = "Already recorded; no change. Do not call todo_write again unless the plan changes.\n"
			}
			if len(unknown) > 0 {
				note += fmt.Sprintf("No todo with id %v — it may be from an earlier list. Current ids are shown below.\n", unknown)
			}
			return tool.Result{Content: note + renderTodos(items), Data: w.planData(items)}
		},
	}
}

// planData is a plan result as values: its items, and what a step is expected to take here.
func (w *Workspace) planData(items []TodoItem) map[string]any {
	return map[string]any{"items": items, "plan": worktime.For(w.Root).PlanStep()}
}

func (w *Workspace) todoRead() *tool.Tool {
	return &tool.Tool{
		Name: "todo_read", Description: "Read the current checklist.", Schema: tool.ObjectSchema(map[string]any{}),
		Capability: tool.CapPlanning, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(context.Context, tool.Context, tool.Args) tool.Result {
			items := w.Todos.Items()
			return tool.Result{Content: renderTodos(items), Data: w.planData(items)}
		},
	}
}
