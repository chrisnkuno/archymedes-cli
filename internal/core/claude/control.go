package claude

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
)

// The person's hand on a sub-agent at work (the Inspector's x and m), as Claude Code's own task
// panel gives it: stop one, or tell it something. A helper the person started (helpers.go) is a
// Claude Code of Friday's, so both work on it. A sub-agent Claude started in the background is
// Claude Code's: it is stopped the way Claude Code's panel stops it (the stop_task control
// request), and Claude Code takes no message for it from outside.

// stopTimeout is how long Claude Code is given to answer a stop.
const stopTimeout = 10 * time.Second

// helperID is the helper known by id: its own id or its card's call id. Called with s.mu held.
func (s *Session) helperID(id string) string {
	id = strings.TrimPrefix(strings.TrimSpace(id), agents.UserCallPrefix)
	if _, ok := s.helpers[id]; ok {
		return id
	}
	return ""
}

// StopAgent stops a sub-agent at work: a helper, or a background sub-agent of Claude's.
func (s *Session) StopAgent(id string) (string, error) {
	s.mu.Lock()
	if h := s.helperID(id); h != "" {
		cancel := s.helpers[h]
		s.mu.Unlock()
		cancel()
		return "Stopping helper " + h + ".", nil
	}
	fl := s.followed(strings.TrimSpace(id))
	task, p := "", s.proc
	if fl != nil {
		task = firstNonEmpty(s.tr.tasks[fl.l.call], fl.l.id)
	}
	s.mu.Unlock()
	switch {
	case fl == nil:
		return "", fmt.Errorf("no sub-agent %q is at work in this session", id)
	case p == nil:
		return "", errors.New("Claude Code is not running, so neither is the sub-agent")
	}
	ctx, cancel := context.WithTimeout(context.Background(), stopTimeout)
	defer cancel()
	if _, err := p.request(ctx, map[string]any{"subtype": "stop_task", "task_id": task}); err != nil {
		return "", fmt.Errorf("Claude Code did not stop it: %w", err)
	}
	return "Stopping " + fl.l.id + "; Claude Code says when it has.", nil
}

// SendAgent tells a helper at work something; it reads it after the tool it is running.
func (s *Session) SendAgent(id, message string) (string, error) {
	message = strings.TrimSpace(message)
	if message == "" {
		return "", errors.New("the message is empty")
	}
	s.mu.Lock()
	h := s.helperID(id)
	run := s.helperRuns[h]
	claudes := s.followed(strings.TrimSpace(id)) != nil
	s.mu.Unlock()
	switch {
	case run != nil:
		if run.Steer(message) {
			return "Sent to helper " + h + "; it reads it after the tool it is running.", nil
		}
		return "", errors.New("the helper is not running a tool just now, so it could not take a message; send again in a moment")
	case h != "":
		return "", errors.New("the helper is still starting; send again in a moment")
	case claudes:
		return "", errors.New("Claude Code takes no message for its own sub-agents from outside; ask Claude to message it (SendMessage), or stop it with x")
	}
	return "", fmt.Errorf("no sub-agent %q is at work in this session", id)
}
