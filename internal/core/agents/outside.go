package agents

import (
	"context"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

// An outside engine (the person's Claude Code) runs a session's turns with its own prompt, tools
// and conversation. The session still owns everything around the turn: its place in line, the
// cancel that stops it, and the transcript, which keeps what was said so another model can carry
// on from it.

// OutsideTurn is one turn as an outside engine ran it.
type OutsideTurn struct {
	// Reply is what the engine said: kept in the transcript.
	Reply string
	// Steers are messages sent while it worked, which it read within the turn.
	Steers []string
	Result loop.Result
}

// Outside runs one turn of the root thread on an outside engine, after every prompt accepted
// before it. run gets the turn's context, cancelled by Cancel like any turn's.
func (s *Session) Outside(ctx context.Context, accepted Accepted, text string, run func(ctx context.Context) OutsideTurn) loop.Result {
	return s.inTurn(ctx, accepted, func(ctx context.Context) loop.Result {
		s.mu.Lock()
		if s.meta.Title == "" {
			s.meta.Title = thread.Title(text)
		}
		s.mu.Unlock()
		_ = s.store.SetStatus(thread.Root, thread.Running, "")
		turn := run(ctx)
		messages := append(s.Messages(), fantasy.NewUserMessage(text))
		for _, steer := range turn.Steers {
			messages = append(messages, fantasy.NewUserMessage("[Sent while you were working] "+steer))
		}
		if turn.Reply != "" {
			messages = append(messages, fantasy.Message{Role: fantasy.MessageRoleAssistant, Content: []fantasy.MessagePart{fantasy.TextPart{Text: turn.Reply}}})
		}
		s.saveRoot(messages)
		status := thread.Idle
		if turn.Result.Status == loop.Failed {
			status = thread.Failed
		}
		_ = s.store.SetStatus(thread.Root, status, "")
		s.mu.Lock()
		_ = s.store.SaveMeta(s.meta)
		s.mu.Unlock()
		return turn.Result
	})
}

// UpdateMeta changes what is stored about the session (an outside engine's own session id, what
// it has seen) and saves it.
func (s *Session) UpdateMeta(change func(*thread.Meta)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	change(&s.meta)
	return s.store.SaveMeta(s.meta)
}
