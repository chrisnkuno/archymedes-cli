package tools

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// TodoItem is one line of the plan.
type TodoItem struct {
	ID     int    `json:"id"`
	Text   string `json:"text"`
	Status string `json:"status"` // pending | in_progress | done
}

// TodoList is the session's checklist (core/cli/tools.ts TodoList): replaced whole, updated by id
// in one call, unknown ids reported rather than failing the batch.
type TodoList struct {
	mu     sync.Mutex
	items  []TodoItem
	nextID int
}

// Replace sets a new list with fresh ids.
func (l *TodoList) Replace(texts []string) []TodoItem {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.items = nil
	for _, text := range texts {
		l.nextID++
		l.items = append(l.items, TodoItem{ID: l.nextID, Text: text, Status: "pending"})
	}
	return slices.Clone(l.items)
}

// SetStatus applies every id that exists and returns the ones that do not.
func (l *TodoList) SetStatus(ids []int, status string) (unknown []int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, id := range ids {
		found := false
		for i := range l.items {
			if l.items[i].ID == id {
				l.items[i].Status = status
				found = true
			}
		}
		if !found {
			unknown = append(unknown, id)
		}
	}
	return unknown
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
				return tool.Result{Content: renderTodos(items), Data: map[string]any{"items": items}}
			}
			complete, start := ids(args["complete"]), ids(args["start"])
			if len(complete) == 0 && len(start) == 0 {
				items := w.Todos.Items()
				return tool.Result{Content: renderTodos(items), Data: map[string]any{"items": items}}
			}
			redundant := len(start) == 0 && w.Todos.alreadyDone(complete)
			unknown := append(w.Todos.SetStatus(start, "in_progress"), w.Todos.SetStatus(complete, "done")...)
			items := w.Todos.Items()
			var note string
			if redundant {
				note = "Already recorded; no change. Do not call todo_write again unless the plan changes.\n"
			}
			if len(unknown) > 0 {
				note += fmt.Sprintf("No todo with id %v — it may be from an earlier list. Current ids are shown below.\n", unknown)
			}
			return tool.Result{Content: note + renderTodos(items), Data: map[string]any{"items": items}}
		},
	}
}

func (w *Workspace) todoRead() *tool.Tool {
	return &tool.Tool{
		Name: "todo_read", Description: "Read the current checklist.", Schema: tool.ObjectSchema(map[string]any{}),
		Capability: tool.CapPlanning, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(context.Context, tool.Context, tool.Args) tool.Result {
			items := w.Todos.Items()
			return tool.Result{Content: renderTodos(items), Data: map[string]any{"items": items}}
		},
	}
}
