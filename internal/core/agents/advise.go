package agents

import (
	"context"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/advise"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// Suggestions beside the work (core/advise): notes on each edit of the root thread as it lands,
// and up to three next steps when a turn that changed code, or ran a check, ends. Both go out as
// notices after the events they are about, and may arrive after the turn's reply: they never hold
// a turn up. ARCHYMEDES_SUGGEST=off turns both off.

// suggestTimeout bounds the work after a turn: the small model's proposals and Jev's ranking.
const suggestTimeout = 25 * time.Second

// turnRecord is what a root turn did, gathered from its events.
type turnRecord struct {
	mu    sync.Mutex
	turn  advise.Turn
	args  map[string]map[string]any // a call's arguments, until its result
	noted map[string]bool           // files already said to have no test beside them
}

func newTurnRecord(request string) *turnRecord {
	return &turnRecord{turn: advise.Turn{Request: request}, args: map[string]map[string]any{}, noted: map[string]bool{}}
}

func (s *Session) suggesting() bool {
	return !strings.EqualFold(s.cfg.Env.Get("ARCHYMEDES_SUGGEST"), "off")
}

// observe records one event of the root turn, and notes an edit once its result is in.
func (s *Session) observe(rec *turnRecord, ev loop.Event) {
	switch ev.Type {
	case loop.EventToolCall:
		rec.mu.Lock()
		rec.args[ev.ToolCallID] = ev.Arguments
		rec.mu.Unlock()
	case loop.EventToolResult:
		rec.mu.Lock()
		args := rec.args[ev.ToolCallID]
		delete(rec.args, ev.ToolCallID)
		rec.mu.Unlock()
		switch ev.ToolName {
		case "run_command":
			command, _ := ev.Data["command"].(string)
			exit, ok := ev.Data["exitCode"].(int)
			if command == "" || !ok {
				return
			}
			verifies := !policy.IsReadOnlyCommand(command, runtime.GOOS) && policy.ClassifyVerification(command) != ""
			rec.mu.Lock()
			rec.turn.Commands = append(rec.turn.Commands, advise.Command{Text: command, Exit: exit, Verifies: verifies})
			rec.mu.Unlock()
		case "edit_file", "write_file":
			path, _ := ev.Data["path"].(string)
			if ev.IsError || path == "" {
				return
			}
			rec.mu.Lock()
			if !slices.Contains(rec.turn.Edited, path) {
				rec.turn.Edited = append(rec.turn.Edited, path)
			}
			rec.mu.Unlock()
			s.noteEdit(rec, ev.ToolCallID, editOf(s.cfg.Root, path, ev.ToolName, args))
		}
	}
}

// editOf is a call's change as before and after text.
func editOf(root, path, toolName string, args map[string]any) advise.Edit {
	e := advise.Edit{Root: root, Path: path}
	if toolName == "write_file" {
		e.After, _ = args["content"].(string)
		return e
	}
	var before, after []string
	if old, ok := args["oldText"].(string); ok {
		neu, _ := args["newText"].(string)
		before, after = append(before, old), append(after, neu)
	}
	if edits, ok := args["edits"].([]any); ok {
		for _, raw := range edits {
			if one, ok := raw.(map[string]any); ok {
				old, _ := one["oldText"].(string)
				neu, _ := one["newText"].(string)
				before, after = append(before, old), append(after, neu)
			}
		}
	}
	e.Before, e.After = strings.Join(before, "\n"), strings.Join(after, "\n")
	return e
}

// noteEdit sends what is worth knowing about an edit: its facts at once when there is no judge,
// or with Jev's notes once it has answered.
func (s *Session) noteEdit(rec *turnRecord, callID string, e advise.Edit) {
	facts := advise.Facts(e)
	rec.mu.Lock()
	facts = slices.DeleteFunc(facts, func(n advise.Note) bool {
		return n.Text == "No test file beside it" && rec.noted[e.Path]
	})
	for _, n := range facts {
		if n.Text == "No test file beside it" {
			rec.noted[e.Path] = true
		}
	}
	rec.mu.Unlock()
	send := func(notes []advise.Note) {
		if len(notes) > 0 {
			s.cfg.Notify(Notice{Kind: "edit_notes", ToolCallID: callID, Path: e.Path, Notes: notes})
		}
	}
	if s.jev == nil || !advise.IsCode(e.Path) {
		send(facts)
		return
	}
	go func() {
		send(append(facts, advise.Judge(s.life, s.jev, e)...))
	}()
}

// suggestAfter sends the next steps for a finished turn, in the background: the rules' own, the
// small model's when ARCHYMEDES_SUGGEST_MODEL is on, ranked by Jev when it is set up. A turn that
// changed nothing and ran no command has none.
func (s *Session) suggestAfter(rec *turnRecord, result loop.Result) {
	if result.Status == loop.Cancelled || result.Status == loop.Failed {
		return
	}
	rec.mu.Lock()
	turn := rec.turn
	turn.Edited, turn.Commands = slices.Clone(turn.Edited), slices.Clone(turn.Commands)
	rec.mu.Unlock()
	if len(turn.Edited) == 0 && len(turn.Commands) == 0 {
		return
	}
	turn.Reply, turn.Status = result.Text, string(result.Status)
	go func() {
		ctx, cancel := context.WithTimeout(s.life, suggestTimeout)
		defer cancel()
		steps := advise.Rules(turn)
		if strings.EqualFold(s.cfg.Env.Get("ARCHYMEDES_SUGGEST_MODEL"), "on") {
			steps = append(steps, advise.Propose(ctx, s.completeSmall, turn)...)
		}
		if steps = advise.Rank(ctx, s.jev, turn, steps); len(steps) > 0 {
			s.cfg.Notify(Notice{Kind: "suggestions", Steps: steps})
		}
	}()
}

// completeSmall is one tool-less call to the small model.
func (s *Session) completeSmall(ctx context.Context, system, user string) (string, error) {
	model, _, err := s.Models().For(ctx, "small")
	if err != nil {
		return "", err
	}
	return complete(ctx, model, fantasy.Prompt{fantasy.NewSystemMessage(system), fantasy.NewUserMessage(user)})
}
