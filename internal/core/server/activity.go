package server

import (
	"math"

	"github.com/chrisnkuno/friday-cli/internal/core/tools"
)

// activityAnswer is the `activity` session command's reply: each command as the interface's "what's
// going on" view reads it (acp.Activity). Times are milliseconds; lastOutputAt is 0 while it has
// printed nothing.
func activityAnswer(all []tools.Activity) map[string]any {
	items := make([]any, 0, len(all))
	for _, a := range all {
		last := int64(0)
		if !a.LastOutput.IsZero() {
			last = a.LastOutput.UnixMilli()
		}
		tail := a.Tail
		if tail == nil {
			tail = []string{}
		}
		items = append(items, map[string]any{
			"id": a.ID, "callId": a.CallID, "command": a.Command, "dir": a.Dir, "pid": a.Pid,
			"background": a.Background, "status": a.Status, "startedAt": a.Started.UnixMilli(),
			"elapsedMs": a.Elapsed.Milliseconds(), "lastOutputAt": last, "quietMs": a.Quiet.Milliseconds(),
			"cpu": math.Round(a.CPU*10) / 10, "cpuKnown": a.CPUKnown, "stuck": a.Stuck, "tail": tail,
		})
	}
	return map[string]any{"kind": "activity", "activities": items}
}
