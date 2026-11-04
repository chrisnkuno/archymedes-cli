package agents

import (
	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/thread"
	"github.com/chrisnkuno/friday-cli/internal/core/worktime"
)

// pastHelperRuns are the helpers the project's earlier sessions ran to the end, for the work-time
// book's first look (worktime.Backfill): each from its start to its last word, in as many steps as
// it made model calls. A failed or stopped one, and one resumed after a restart (its time spans
// the restart), say nothing about how long its role takes.
func pastHelperRuns(root string) []worktime.Run {
	var runs []worktime.Run
	for _, summary := range thread.List(root, 0) {
		store, err := thread.Open(root, summary.ID)
		if err != nil {
			continue
		}
		threads, _ := store.Threads()
		for _, t := range threads {
			if t.Status != thread.Done || t.WasInterrupted || t.Role == "" || t.CreatedAt.IsZero() {
				continue
			}
			steps := 0
			if messages, err := store.Messages(t.ID); err == nil {
				for _, msg := range messages {
					if msg.Role == fantasy.MessageRoleAssistant {
						steps++
					}
				}
			}
			runs = append(runs, worktime.Run{Role: t.Role, Took: t.UpdatedAt.Sub(t.CreatedAt), Steps: steps})
		}
	}
	return runs
}
