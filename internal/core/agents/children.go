package agents

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/roles"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
	"github.com/chrisnkuno/friday-cli/internal/core/tools"
)

// child is one sub-agent run: a child thread working on a brief.
type child struct {
	t       thread.Thread
	profile roles.Profile
	inbox   *loop.Inbox
	ws      *tools.Workspace
	done    chan struct{}
	cancel  context.CancelFunc

	mu        sync.Mutex
	result    loop.Result
	report    string
	collected bool
	// usage is every token its model calls have used, earlier runs included (resumed after a
	// restart); model is the model it runs on.
	usage loop.Usage
	model string
}

// spent is the child's tokens so far, for a thread notice.
func (c *child) spent() *loop.Usage {
	c.mu.Lock()
	defer c.mu.Unlock()
	u := c.usage
	return &u
}

// count folds one model call into the child's total and records the total, so a restart keeps it.
func (c *child) count(s *Session, u loop.Usage) {
	c.mu.Lock()
	c.usage.Add(u)
	total := c.usage
	c.mu.Unlock()
	_ = s.store.SetUsage(c.t.ID, thread.Usage(total))
}

func (c *child) stop() {
	if c.cancel != nil {
		c.cancel()
	}
}

func (c *child) finished() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

// subagentEvents are the child events the interface shows under its card (SubagentEvent in TS).
var subagentEvents = map[string]bool{loop.EventToolCall: true, loop.EventToolResult: true, loop.EventModelTurn: true, loop.EventRetry: true}

// interruptedNote is what a resumed child is told after a restart cut it off.
const interruptedNote = "You were interrupted (Friday restarted). Your work so far is above. Continue the brief from where you stopped, without redoing finished steps, and end with your report."

// spawnSpec is what a delegation asks for.
type spawnSpec struct {
	profile    roles.Profile
	brief      string
	fork       string
	background bool
	callID     string
}

// startChild records a new child thread and starts it. A background child runs under the
// session's life; a foreground one under the turn that asked, so stopping the turn stops it.
func (s *Session) startChild(turnCtx context.Context, spec spawnSpec) (*child, error) {
	t := thread.Thread{
		ID: thread.NewThreadID(), Parent: thread.Root, CallID: spec.callID, Role: spec.profile.Name,
		Brief: spec.brief, Fork: spec.fork, Background: spec.background, Model: spec.profile.Model,
	}
	ws := s.ws
	if spec.background && !spec.profile.ReadOnly {
		dir, branch, err := s.addWorktree(t.ID)
		if err != nil {
			return nil, err
		}
		t.Worktree, t.Branch = dir, branch
		ws = s.ws.At(dir)
	}
	history := thread.Fork(s.Messages(), spec.fork)
	if err := s.store.Spawn(t); err != nil {
		return nil, err
	}
	return s.launch(turnCtx, t, spec.profile, ws, history, spec.brief), nil
}

// launch runs a child thread from history and prompt, registering it while it runs.
func (s *Session) launch(turnCtx context.Context, t thread.Thread, profile roles.Profile, ws *tools.Workspace, history []fantasy.Message, prompt string) *child {
	base := turnCtx
	if t.Background {
		base = s.life
	}
	ctx, cancel := context.WithCancel(base)
	c := &child{t: t, profile: profile, inbox: loop.NewInbox(), ws: ws, done: make(chan struct{}), cancel: cancel}
	if t.Usage != nil {
		c.usage = loop.Usage(*t.Usage)
	}
	s.childMu.Lock()
	s.children[t.ID] = c
	s.childMu.Unlock()
	s.noticeThread(c, thread.Running, "")
	go s.runChild(ctx, c, history, prompt)
	return c
}

func (s *Session) runChild(ctx context.Context, c *child, history []fantasy.Message, prompt string) {
	defer close(c.done)
	defer c.cancel()
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-ctx.Done():
		if !s.pausedByClose(c, loop.Result{Status: loop.Cancelled}) {
			c.finish(s, loop.Result{Status: loop.Cancelled}, "")
		}
		return
	}
	model, modelID, err := s.Models().For(ctx, c.profile.Model)
	if err != nil {
		c.finish(s, loop.Result{Status: loop.Failed, Err: err}, "")
		return
	}
	c.mu.Lock()
	c.model = modelID
	c.mu.Unlock()
	mode := s.Mode()
	catalog := tool.NewCatalog(roles.ToolsFor(c.profile, filterByMode(s.withDiagnostics(c.ws.Builtins()), mode), policy.CapabilitiesForMode(policy.Plan))...)
	var verify *gate.Gate
	if !c.profile.ReadOnly && mode != policy.Plan {
		verify = gate.New(s.cfg.TestFirst)
	}
	budgets := s.cfg.Budgets
	budgets.MaxSteps = c.profile.MaxIterations
	budgets.MaxToolCalls = c.profile.MaxToolCalls
	budgets.MaxResultChars = roles.SubagentResultChars
	s.mu.Lock()
	ledger := s.ledger
	s.mu.Unlock()
	result := loop.Run(ctx, loop.Request{
		ThreadID: c.t.ID, Root: c.ws.Root, Model: model,
		System:  s.childSystemPrompt(c, modelID),
		History: history, Prompt: prompt, Tools: catalog,
		Approve: ledger.Decide, Gate: verify, Inbox: c.inbox, Budgets: budgets, WrapUp: roles.WrapUp, Hooks: childHooks{s.hooks},
		Emit: func(ev loop.Event) {
			if ev.Type == loop.EventModelTurn && ev.Usage != nil {
				c.count(s, *ev.Usage)
			}
			if subagentEvents[ev.Type] {
				ev := ev
				s.cfg.Notify(Notice{Kind: "subagent", Event: &ev, ParentToolCallID: c.t.CallID, Agent: c.profile.Name})
			}
		},
		Checkpoint: func(m []fantasy.Message) { _ = s.store.SaveMessages(c.t.ID, m) },
	})
	_ = s.store.SaveMessages(c.t.ID, result.Messages)
	if s.pausedByClose(c, result) {
		return
	}
	extra := ""
	if c.t.Worktree != "" {
		extra = s.closeWorktree(c)
	}
	c.finish(s, result, extra)
}

// pausedByClose records a background child that stopped only because its session closed: it is
// paused, with its conversation saved, and resumes on the next load. A foreground child, or one
// someone stopped, has ended for good.
func (s *Session) pausedByClose(c *child, result loop.Result) bool {
	if !c.t.Background || result.Status != loop.Cancelled || s.life.Err() == nil {
		return false
	}
	c.mu.Lock()
	c.result, c.report = result, "(paused: Friday closed; it resumes when this session is opened again)"
	c.mu.Unlock()
	_ = s.store.SetStatus(c.t.ID, thread.Paused, "")
	return true
}

// finish records how a child ended and passes its report on.
func (c *child) finish(s *Session, result loop.Result, extra string) {
	report := strings.TrimSpace(result.Text)
	if report == "" {
		report = "(The sub-agent ended without a report.)"
	}
	if result.Status != loop.Completed {
		why := string(result.Status)
		if result.Err != nil {
			why += ": " + result.Err.Error()
		}
		report += fmt.Sprintf("\n\n[sub-agent ended: %s, %d step(s), %d tool call(s)]", why, result.Steps, result.Calls)
	}
	if extra != "" {
		report += "\n\n" + extra
	}
	status := thread.Done
	switch result.Status {
	case loop.Cancelled:
		status = thread.Cancelled
	case loop.Failed:
		status = thread.Failed
	}
	c.mu.Lock()
	c.result, c.report = result, report
	c.mu.Unlock()
	_ = s.store.SetStatus(c.t.ID, status, report)
	s.noticeThread(c, status, report)
	if c.t.Background {
		// The parent may be mid-turn (it reads this at its next step) or idle (its next turn does).
		s.inbox.NotifyKey(c.t.ID, fmt.Sprintf("[Background sub-agent %s (%s) finished: %s]\n%s", c.t.ID, c.profile.Name, status, report))
	}
}

func (s *Session) noticeThread(c *child, status, report string) {
	c.mu.Lock()
	model := c.model
	c.mu.Unlock()
	s.cfg.Notify(Notice{Kind: "thread", Thread: &ThreadInfo{
		ID: c.t.ID, ParentToolCallID: c.t.CallID, Agent: c.profile.Name, Status: status,
		Background: c.t.Background, Brief: c.t.Brief, Report: report, Branch: c.t.Branch,
		Model: model, Usage: c.spent(),
	}})
}

// resumeInterrupted restarts a child that was running when Friday last stopped. Its parent's
// tool call died with the process, so it always finishes as a background child: its report
// reaches the conversation as a notice.
func (s *Session) resumeInterrupted(t thread.Thread) {
	profile, ok := s.profile(t.Role)
	if !ok {
		_ = s.store.SetStatus(t.ID, thread.Failed, "Its role "+t.Role+" no longer exists.")
		return
	}
	history, err := s.store.Messages(t.ID)
	if err != nil {
		_ = s.store.SetStatus(t.ID, thread.Failed, "Its conversation could not be read: "+err.Error())
		return
	}
	ws := s.ws
	if t.Worktree != "" {
		ws = s.ws.At(t.Worktree)
	}
	t.Background = true
	_ = s.store.SetStatus(t.ID, thread.Running, "")
	prompt := interruptedNote
	if len(history) == 0 {
		prompt = t.Brief // it had not started its first step
	}
	s.launch(s.life, t, profile, ws, thread.Complete(history), prompt)
}

func (s *Session) profile(name string) (roles.Profile, bool) {
	for _, p := range s.profiles {
		if p.Name == name {
			return p, true
		}
	}
	return roles.Profile{}, false
}

func (s *Session) lookupChild(id string) (*child, bool) {
	s.childMu.Lock()
	defer s.childMu.Unlock()
	c, ok := s.children[id]
	return c, ok
}

func filterByMode(list []*tool.Tool, mode policy.Mode) []*tool.Tool {
	allowed := map[string]bool{}
	for _, c := range policy.CapabilitiesForMode(mode) {
		allowed[c] = true
	}
	var out []*tool.Tool
	for _, t := range list {
		if allowed[t.Capability] {
			out = append(out, t)
		}
	}
	return out
}

// Threads lists the session's sub-agents as stored, oldest first.
func (s *Session) Threads() []thread.Thread {
	all, _ := s.store.Threads()
	var out []thread.Thread
	for _, t := range all {
		if t.ID != thread.Root {
			out = append(out, t)
		}
	}
	return out
}

// waitFor blocks until every child is done, the timeout passes, or ctx ends; it returns the ones
// still running.
func waitFor(ctx context.Context, children []*child, timeout time.Duration) []*child {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for _, c := range children {
		select {
		case <-c.done:
		case <-deadline.C:
			return pending(children)
		case <-ctx.Done():
			return pending(children)
		}
	}
	return nil
}

func pending(children []*child) []*child {
	var out []*child
	for _, c := range children {
		if !c.finished() {
			out = append(out, c)
		}
	}
	return out
}
