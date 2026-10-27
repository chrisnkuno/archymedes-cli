package agents

import (
	"context"
	"errors"
	"strings"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

const summaryRequest = `Summarize the conversation above for yourself, so you can continue the work with only this summary and the last exchange. Keep: the goal and every requirement the user stated; decisions made and why; files read and changed, with paths; commands run and what they showed; the current state; what remains, in order; open questions. Be specific (paths, names, numbers) and brief. No preamble.`

// compactor summarizes the earlier part of a long conversation on the small model, keeping the
// latest exchange as it was (from the last message the person sent).
func (s *Session) compactor() func(context.Context, []fantasy.Message) ([]fantasy.Message, error) {
	return s.compactorFocused("")
}

// compactorFocused is compactor, told to keep what focus names in full (/compact <focus>).
func (s *Session) compactorFocused(focus string) func(context.Context, []fantasy.Message) ([]fantasy.Message, error) {
	return func(ctx context.Context, messages []fantasy.Message) ([]fantasy.Message, error) {
		model, _, err := s.Models().For(ctx, "small")
		if err != nil {
			return nil, err
		}
		cut := lastUserIndex(messages)
		if cut <= 0 {
			return nil, errors.New("nothing before the latest message to summarize")
		}
		earlier := thread.Complete(messages[:cut])
		request := summaryRequest
		if focus = strings.TrimSpace(focus); focus != "" {
			request += "\nKeep everything about this in full detail: " + focus
		}
		summary, err := complete(ctx, model, append(earlier, fantasy.NewUserMessage(request)))
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(summary) == "" {
			return nil, errors.New("the summary came back empty")
		}
		tail := thread.Complete(messages[cut:])
		if s.cps != nil {
			s.cps.ForgetConversation() // the old lengths point into a conversation that is gone
		}
		first := tail[0]
		first.Content = append([]fantasy.MessagePart{fantasy.TextPart{Text: "Summary of the conversation so far:\n" + summary + "\n\n---\n"}}, first.Content...)
		return append([]fantasy.Message{first}, tail[1:]...), nil
	}
}

func lastUserIndex(messages []fantasy.Message) int {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == fantasy.MessageRoleUser {
			return i
		}
	}
	return -1
}

// complete is one call with no tools, its text collected.
func complete(ctx context.Context, model loop.Model, prompt fantasy.Prompt) (string, error) {
	stream, err := model.Stream(ctx, fantasy.Call{Prompt: prompt})
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for part := range stream {
		switch part.Type {
		case fantasy.StreamPartTypeTextDelta:
			b.WriteString(part.Delta)
		case fantasy.StreamPartTypeError:
			if part.Error != nil {
				return "", part.Error
			}
		}
	}
	return b.String(), ctx.Err()
}

// Summarize compacts the root conversation now (the /compact command), keeping what focus names
// in full. It takes a turn's place in line, so a turn sent meanwhile runs after it on the shorter
// conversation instead of being overwritten by it.
func (s *Session) Summarize(ctx context.Context, focus string) (before, after int, err error) {
	result := s.inTurn(ctx, s.Accept(), func(ctx context.Context) loop.Result {
		messages := s.Messages()
		shorter, err := s.compactorFocused(focus)(ctx, messages)
		if err != nil {
			return loop.Result{Status: loop.Failed, Err: err}
		}
		s.saveRoot(shorter)
		before, after = len(messages), len(shorter)
		ev := loop.Event{Type: loop.EventCompaction, MessagesBefore: before, MessagesAfter: after}
		s.cfg.Notify(Notice{Kind: "compaction", Event: &ev})
		return loop.Result{Status: loop.Completed}
	})
	if result.Status != loop.Completed {
		if result.Err != nil {
			return 0, 0, result.Err
		}
		return 0, 0, errors.New("compaction was cancelled")
	}
	return before, after, nil
}

const titleRequest = "Write a title for this request: at most six words, no quotes, no full stop. Reply with the title only.\n\n"

// nameSession asks the small model for a title in the background; the first line of the request
// stays the title if it cannot (Crush's GenerateTitle, on the small model for the same reason).
func (s *Session) nameSession(request string) {
	go func() {
		ctx, cancel := context.WithTimeout(s.life, 30*time.Second)
		defer cancel()
		model, _, err := s.Models().For(ctx, "small")
		if err != nil {
			return
		}
		title, err := complete(ctx, model, fantasy.Prompt{fantasy.NewUserMessage(titleRequest + request)})
		title = strings.Trim(strings.TrimSpace(strings.SplitN(strings.TrimSpace(title), "\n", 2)[0]), `"'.`)
		if err != nil || title == "" || len([]rune(title)) > 80 {
			return
		}
		s.mu.Lock()
		s.meta.Title = title
		_ = s.store.SaveMeta(s.meta)
		s.mu.Unlock()
	}()
}
