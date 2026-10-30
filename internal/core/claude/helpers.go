package claude

import (
	"context"
	"fmt"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

// Helpers the person starts (/agent, alt+a) while Claude runs the session. Each is a Claude Code
// of its own, started for one brief and closed after it, so several work at once beside the
// conversation. Its tool calls, results and model turns go out as the sub-agent events of its
// card (call id agents.UserCallPrefix…), its start and end as thread events, exactly as a helper
// on Friday's own engine. Its report is told to this session's Claude before the next prompt. A
// read-only role runs in plan mode; a writable one in this session's mode, in the same folder,
// asking before what this session asks before.

// MaxHelpers is how many helpers may run at once on one session.
const MaxHelpers = 4

// helperEvents are a helper's events its card shows.
var helperEvents = map[string]bool{loop.EventToolCall: true, loop.EventToolResult: true, loop.EventModelTurn: true, loop.EventRetry: true}

// Role is what a helper is: its name, whether it may change files, and its own instructions
// (from a Friday role, roles.Profile).
type Role struct {
	Name, Instructions string
	ReadOnly           bool
}

// Helper is one helper Claude runs.
type Helper struct {
	ID, CallID string
	Profile    Role
	Brief      string
}

// StartHelper starts profile on brief and returns at once.
func (s *Session) StartHelper(profile Role, brief string) (Helper, error) {
	h := Helper{ID: thread.NewThreadID(), Profile: profile, Brief: brief}
	h.CallID = agents.UserCallPrefix + h.ID
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	switch {
	case s.closed:
		s.mu.Unlock()
		cancel()
		return Helper{}, fmt.Errorf("this session is closed")
	case len(s.helpers) >= MaxHelpers:
		s.mu.Unlock()
		cancel()
		return Helper{}, fmt.Errorf("%d helpers are already at work, the most at once; start this one when one finishes", MaxHelpers)
	}
	if s.helpers == nil {
		s.helpers = map[string]context.CancelFunc{}
	}
	s.helpers[h.ID] = cancel
	mode := s.mode
	model := firstNonEmpty(s.model, s.tr.model)
	s.mu.Unlock()

	opts := s.opts
	opts.Resume, opts.Preface, opts.Model = "", "", model
	opts.Transcript = func() string { return "" }
	opts.Mode = mode
	if profile.ReadOnly {
		opts.Mode = policy.Plan
	}
	parent := s.opts.Notify
	opts.Notify = func(n agents.Notice) {
		if n.Kind == "runtime" && n.Event != nil && helperEvents[n.Event.Type] {
			parent(agents.Notice{Kind: "subagent", Event: n.Event, ParentToolCallID: h.CallID, Agent: profile.Name})
		}
	}
	tell := func(status, report string) {
		parent(agents.Notice{Kind: "thread", Thread: &agents.ThreadInfo{
			ID: h.ID, ParentToolCallID: h.CallID, Agent: profile.Name, Status: status,
			Background: true, Brief: brief, Report: report, Model: "claude " + firstNonEmpty(model, "default"),
		}})
	}
	tell(thread.Running, "")
	go func() {
		defer func() {
			cancel()
			s.mu.Lock()
			delete(s.helpers, h.ID)
			s.mu.Unlock()
		}()
		status, report := s.runHelper(ctx, opts, h)
		tell(status, report)
		s.mu.Lock()
		if !s.closed {
			s.preface = strings.TrimSpace(s.preface + fmt.Sprintf("\n\n[Background helper %s (%s) finished: %s]\n%s", h.ID, profile.Name, status, report))
		}
		s.mu.Unlock()
	}()
	return h, nil
}

// runHelper runs a helper's one turn on a Claude Code of its own, and says how it ended.
func (s *Session) runHelper(ctx context.Context, opts Options, h Helper) (status, report string) {
	c, err := Open(ctx, opts)
	if err != nil {
		return thread.Failed, "Claude Code did not start for the helper: " + err.Error()
	}
	defer c.Close()
	out := c.Turn(ctx, helperPrompt(h))
	report = strings.TrimSpace(out.Reply)
	if report == "" {
		report = "(The helper ended without a report.)"
	}
	switch out.Result.Status {
	case loop.Cancelled:
		return thread.Cancelled, report
	case loop.Failed:
		if out.Result.Err != nil {
			report += "\n\n[helper ended: " + out.Result.Err.Error() + "]"
		}
		return thread.Failed, report
	}
	return thread.Done, report
}

// helperPrompt is a helper's one message: who it is, its role's instructions, and the brief.
func helperPrompt(h Helper) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are Friday's %s helper, started by the person and working in the background beside their main conversation. ", h.Profile.Name)
	b.WriteString("Nobody can answer questions while you work: decide for yourself, and do only what the task needs.")
	if h.Profile.ReadOnly {
		b.WriteString(" Change nothing; read and report.")
	}
	if in := strings.TrimSpace(h.Profile.Instructions); in != "" {
		b.WriteString("\n\n" + in)
	}
	b.WriteString("\n\nYour task:\n" + h.Brief)
	b.WriteString("\n\nEnd with a short report: what you found or changed, with file paths.")
	return b.String()
}

// stopHelpers stops every helper still at work; called as the session closes.
func (s *Session) stopHelpers() {
	for _, cancel := range s.helpers {
		cancel()
	}
}
