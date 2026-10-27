package agents

import (
	"context"
	"errors"
	"strings"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/checkpoint"
)

// Undo, rewind and diff: the workspace is snapshotted before every root turn (internal/core/checkpoint);
// going back restores the files, cuts the conversation to where it was, or both.

// errNoUndo is the answer outside a git repository, where no checkpoint can be taken.
var errNoUndo = errors.New("undo needs a git repository: this folder is not one, so no checkpoints were taken")

// captureTurn snapshots the workspace before a root turn; a failure only means no undo for it.
func (s *Session) captureTurn(ctx context.Context, text string, messageCount int) {
	if s.cps == nil {
		return
	}
	label := strings.TrimSpace(strings.SplitN(strings.TrimSpace(text), "\n", 2)[0])
	if r := []rune(label); len(r) > 60 {
		label = string(r[:59]) + "…"
	}
	s.cps.Capture(ctx, label, messageCount)
}

// Turns are the checkpoints, one before each turn, oldest first.
func (s *Session) Turns() []checkpoint.Checkpoint {
	if s.cps == nil {
		return nil
	}
	return s.cps.List()
}

// Back goes to before turn index (the last one when index is -1), restoring what scope names. It
// says what was gone back to and whether the conversation could follow (not after compaction).
func (s *Session) Back(ctx context.Context, index int, scope checkpoint.Scope) (checkpoint.Checkpoint, bool, error) {
	if s.cps == nil {
		return checkpoint.Checkpoint{}, false, errNoUndo
	}
	s.turnMu.Lock()
	busy := s.busy
	s.turnMu.Unlock()
	if busy {
		return checkpoint.Checkpoint{}, false, errors.New("a turn is running: stop it first, then go back")
	}
	if index < 0 {
		index = len(s.cps.List()) - 1
	}
	c, err := s.cps.Back(ctx, index, scope)
	if err != nil {
		return c, false, err
	}
	conversation := false
	if scope != checkpoint.Code && c.MessageCount >= 0 {
		s.mu.Lock()
		messages := s.messages
		s.mu.Unlock()
		if c.MessageCount <= len(messages) {
			s.saveRoot(append([]fantasy.Message(nil), messages[:c.MessageCount]...))
			conversation = true
		}
	}
	return c, conversation, nil
}

// Diff is what changed since the last checkpoint (a patch, or a summary per file with stat).
func (s *Session) Diff(ctx context.Context, stat bool) (string, error) {
	if s.cps == nil {
		return "", errNoUndo
	}
	return s.cps.Diff(ctx, stat), nil
}

// TurnPatch is what turn index changed.
func (s *Session) TurnPatch(ctx context.Context, index int) (string, error) {
	if s.cps == nil {
		return "", errNoUndo
	}
	return s.cps.TurnPatch(ctx, index), nil
}
