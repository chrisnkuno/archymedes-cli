package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Command answers a session command while Claude runs the session, as the TypeScript engine's
// ClaudeSession does: the reply kinds the interface renders (text, todos, error).
func (s *Session) Command(command, argument string) map[string]any {
	text := func(t string) map[string]any { return map[string]any{"kind": "text", "text": t} }
	switch command {
	case "undo":
		return s.undo(argument)
	case "cost":
		return text(s.costReport())
	case "todos":
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.tr.todos) == 0 {
			return text("No plan yet.")
		}
		var items []any
		for _, item := range s.tr.todos {
			items = append(items, map[string]any{"text": item.Text, "status": item.Status})
		}
		return map[string]any{"kind": "todos", "items": items}
	case "tools":
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.tr.tools) == 0 {
			return text("Claude Code lists its tools when the first turn starts.")
		}
		return text(fmt.Sprintf("%d tools (Claude Code's)\n%s", len(s.tr.tools), strings.Join(s.tr.tools, "\n")))
	case "diff":
		return text("Claude's edits are in Changes (F10), file by file, against the last commit.")
	case "memory":
		return text("Claude Code keeps its own memory (CLAUDE.md files); /memory is for Friday's models.")
	}
	return map[string]any{"kind": "error", "text": fmt.Sprintf("/%s is not available while Claude runs this session.", command)}
}

// undo puts back the files Claude changed in the last turn, from Claude Code's own checkpoints.
func (s *Session) undo(argument string) map[string]any {
	failed := func(t string) map[string]any { return map[string]any{"kind": "error", "text": t} }
	switch argument {
	case "conversation":
		return map[string]any{"kind": "text", "text": "Claude keeps its conversation; /undo code puts back the files it changed."}
	case "", "code":
	default:
		return failed(fmt.Sprintf("/undo takes no argument, \"code\", or \"conversation\" — not %q.", argument))
	}
	s.mu.Lock()
	busy, p := s.turn != nil, s.proc
	var last turnID
	if len(s.turnIDs) > 0 {
		last = s.turnIDs[len(s.turnIDs)-1]
	}
	s.mu.Unlock()
	if busy {
		return failed("Wait for the turn to finish, or stop it, before undoing.")
	}
	if last.id == "" || p == nil {
		return map[string]any{"kind": "text", "text": "Nothing to undo."}
	}
	rewind := func(dryRun bool) (rewindAnswer, error) {
		var answer rewindAnswer
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		raw, err := p.request(ctx, map[string]any{"subtype": "rewind_files", "user_message_id": last.id, "dry_run": dryRun})
		if err == nil {
			err = json.Unmarshal(raw, &answer)
		}
		return answer, err
	}
	preview, err := rewind(true)
	if err == nil && preview.CanRewind {
		var done rewindAnswer
		done, err = rewind(false)
		preview.CanRewind, preview.Error = done.CanRewind, done.Error
	}
	if err != nil {
		return failed("Claude Code could not put the files back: " + err.Error())
	}
	if !preview.CanRewind {
		return failed(firstNonEmpty(preview.Error, "Claude Code could not put the files back."))
	}
	s.mu.Lock()
	if n := len(s.turnIDs); n > 0 && s.turnIDs[n-1].id == last.id {
		s.turnIDs = s.turnIDs[:n-1]
	}
	s.mu.Unlock()
	switch files := len(preview.FilesChanged); files {
	case 0:
		return map[string]any{"kind": "text", "text": fmt.Sprintf("Nothing Claude edited in %q needed putting back.", last.title)}
	case 1:
		return map[string]any{"kind": "text", "text": fmt.Sprintf("Put back the file Claude changed in %q. (Commands it ran are not undone.)", last.title)}
	default:
		return map[string]any{"kind": "text", "text": fmt.Sprintf("Put back %d files Claude changed in %q. (Commands it ran are not undone.)", files, last.title)}
	}
}

// rewindAnswer is Claude Code's answer to rewind_files.
type rewindAnswer struct {
	CanRewind    bool     `json:"canRewind"`
	Error        string   `json:"error"`
	FilesChanged []string `json:"filesChanged"`
}

func (s *Session) costReport() string {
	s.mu.Lock()
	totals, limit := s.tr.totals, s.tr.rateLimit
	s.mu.Unlock()
	lines := []string{
		fmt.Sprintf("%d model calls · %s tokens in (%s from cache) · %s out", totals.Calls, thousands(totals.Input), thousands(totals.CacheRead), thousands(totals.Output)),
		fmt.Sprintf("Billed to your Claude plan, not per token (Claude Code's API-price estimate: $%.2f).", totals.CostUSD),
	}
	if limit != nil && limit.Utilization > 0 {
		window := "current"
		if limit.RateLimitType == "five_hour" {
			window = "five-hour"
		}
		lines = append(lines, fmt.Sprintf("Plan usage: %d%% of the %s limit.", int(math.Round(limit.Utilization*100)), window))
	}
	return strings.Join(lines, "\n")
}

// thousands is n with commas: 12,345.
func thousands(n int) string {
	digits := strconv.Itoa(n)
	var b strings.Builder
	for i, d := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 && digits[i-1] != '-' {
			b.WriteByte(',')
		}
		b.WriteRune(d)
	}
	return b.String()
}
