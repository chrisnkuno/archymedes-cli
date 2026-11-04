package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/render"
)

// delegationTools start a sub-agent; their card shows its work as it happens.
var delegationTools = map[string]bool{"delegate_task": true, "delegate_readonly_task": true}

// recentSubagentCalls is how many of a running sub-agent's calls its card lists.
const recentSubagentCalls = 3

// Bounds on what is kept of a sub-agent's work for the inspector (app_inspect.go): its steps, the
// oldest dropped first, and each step's output.
const (
	maxSubagentSteps  = 400
	maxSubagentResult = 32 << 10
)

// subagentStep is one call a sub-agent made, and what came back.
type subagentStep struct {
	id, tool       string
	args           map[string]any
	line           string // "read file src/app.ts": the tool in words and the argument that matters
	result         string
	done, isError  bool
	started, ended time.Time
	// diff is an edit's diff, as on an edit card (chat_editdiff.go).
	diff           string
	added, removed int
	// said: not a call but the sub-agent's own words (result), said in model call iteration.
	said      bool
	iteration int
}

// subagentRun is what one sub-agent has done so far, under the delegation call that started it.
type subagentRun struct {
	agent         string
	calls, failed int
	tokens        int
	recent        []string // its latest calls, oldest first, at most recentSubagentCalls
	said          string   // the last line of what it last said
	model         string   // the model it runs on, from its model calls (else its thread)
	steps         []*subagentStep
	dropped       int // steps dropped from the front past maxSubagentSteps
	// background and status come from the Go engine's thread events: a background sub-agent's
	// call returns at once, and the card follows the thread instead until it ends.
	background bool
	status     string
	thread     string
	// started, maxSteps and estimate come with its thread (the Go engine's core/worktime), turns
	// from its model calls: together, about how long it has left (chat_worktime.go).
	started  time.Time
	maxSteps int
	estimate *acp.WorkEstimate
	turns    int
}

// agentStopped reports whether a card's sub-agent was stopped (x, close_agent, Claude Code's own
// stop) rather than finishing: it is drawn so, not as done.
func agentStopped(t *toolItem) bool { return t.sub != nil && t.sub.status == "cancelled" }

// backgroundRunning reports whether a card's sub-agent works on after its call returned.
func backgroundRunning(t *toolItem) bool {
	return t.sub != nil && t.sub.background && t.sub.status == "running"
}

// handleThread follows a sub-agent thread. A background one's report replaces the card's output
// ("started in the background") when it ends; with no card on screen, a line says it finished.
func (m *Model) handleThread(th *acp.ThreadInfo) {
	if th == nil {
		return
	}
	ended := th.Status == "done" || th.Status == "failed" || th.Status == "cancelled"
	t := m.tools[th.ParentToolCallID]
	if t == nil {
		t = m.userAgentCard(th)
	}
	if t == nil {
		if ended && th.Background {
			m.notice(noticeFaint, fmt.Sprintf("Background agent %s (%s) %s; its report reaches Friday with your next message", th.ID, th.Agent, th.Status))
		}
		return
	}
	if t.sub == nil {
		t.sub = &subagentRun{}
	}
	t.sub.agent, t.sub.thread, t.sub.background, t.sub.status = th.Agent, th.ID, th.Background, th.Status
	if !th.StartedAt.IsZero() {
		t.sub.started = th.StartedAt
	} else if t.sub.started.IsZero() {
		t.sub.started = time.Now() // an engine that does not say: from when it was first seen
	}
	if th.Estimate != nil {
		t.sub.estimate, t.sub.maxSteps = th.Estimate, th.MaxSteps
	}
	if t.sub.model == "" && th.Model != "" && th.Model != "claude" {
		t.sub.model = th.Model
	}
	if u := th.Usage; u != nil && u.InputTokens+u.OutputTokens > t.sub.tokens {
		// The engine's count is the whole of it, steps before a restart included.
		t.sub.tokens = u.InputTokens + u.OutputTokens
	}
	if ended {
		// Whatever it was running ended with it: no step spins on after its sub-agent.
		for _, st := range t.sub.steps {
			if !st.done {
				st.done, st.isError, st.ended = true, th.Status != "done", time.Now()
				st.result = firstNonEmpty(st.result, "Ended with the sub-agent ("+th.Status+").")
			}
		}
	}
	if th.Background && ended {
		t.result, t.isError, t.ended = th.Report, th.Status == "failed", time.Now()
		if m.phase != busy {
			m.notice(noticeFaint, fmt.Sprintf("Background agent %s (%s) %s; its report reaches Friday with your next message", th.ID, th.Agent, th.Status))
		}
	}
	t.touch()
}

// handleSubagent folds one of a sub-agent's own events into its delegation card, and its spend
// into the session's: a sub-agent's requests count against the same rate limit and the same bill.
func (m *Model) handleSubagent(ev acp.Event) {
	if ev.Event == nil {
		return
	}
	inner := *ev.Event
	now := time.Now()
	if inner.Type == "model_turn" {
		m.limits.call(now)
		if u := inner.Usage; u != nil {
			m.stats.call(u.InputTokens, u.OutputTokens, now)
			m.turnUsage.input += u.InputTokens
			m.turnUsage.output += u.OutputTokens
			m.usage.input += u.InputTokens
			m.usage.output += u.OutputTokens
		}
	}
	if inner.Type == "provider_retry" && inner.Reason == "rate_limit" {
		m.limits.rateLimited(now)
	}
	t := m.tools[ev.ParentToolCallID]
	if t == nil {
		return
	}
	if t.sub == nil {
		t.sub = &subagentRun{agent: ev.Agent}
	}
	if step := t.sub.apply(inner, now); step != nil && step.done {
		m.subagentEditLanded(t, step)
		m.noteCommands(step.tool, step.args, step.result)
	}
	t.touch()
}

// apply folds one event into the run; it returns the step the event was about, if any.
func (s *subagentRun) apply(ev acp.RuntimeEvent, now time.Time) *subagentStep {
	switch ev.Type {
	case "assistant_delta":
		s.say(ev.Text, ev.Iteration, now)
	case "tool_call":
		s.calls++
		line := strings.ReplaceAll(ev.ToolName, "_", " ")
		if detail := render.DescribeToolCall(ev.ToolName, ev.Arguments); detail != "" {
			line += " " + detail
		}
		s.recent = append(s.recent, line)
		if len(s.recent) > recentSubagentCalls {
			s.recent = s.recent[len(s.recent)-recentSubagentCalls:]
		}
		step := &subagentStep{id: ev.ToolCallID, tool: ev.ToolName, args: ev.Arguments, line: line, started: now}
		s.add(step)
		return step
	case "tool_result":
		if ev.IsError {
			s.failed++
		}
		for i := len(s.steps) - 1; i >= 0; i-- {
			if st := s.steps[i]; st.id == ev.ToolCallID && !st.done {
				st.done, st.isError, st.ended = true, ev.IsError, now
				st.result = ev.Content
				if len(st.result) > maxSubagentResult {
					st.result = st.result[:maxSubagentResult] + "\n[the rest is not kept]"
				}
				return st
			}
		}
	case "model_turn":
		s.turns++
		if ev.Model != "" {
			s.model = ev.Model
		}
		if ev.Usage != nil {
			s.tokens += ev.Usage.InputTokens + ev.Usage.OutputTokens
		}
	}
	return nil
}

// add puts a step at the end of the timeline, dropping the oldest past maxSubagentSteps.
func (s *subagentRun) add(step *subagentStep) {
	s.steps = append(s.steps, step)
	if over := len(s.steps) - maxSubagentSteps; over > 0 {
		s.steps = append(s.steps[:0:0], s.steps[over:]...)
		s.dropped += over
	}
}

// say adds words the sub-agent said: streamed pieces of one model call join the step they continue,
// a new call (or words after a tool call) starts a step of their own.
func (s *subagentRun) say(text string, iteration int, now time.Time) {
	if text == "" {
		return
	}
	var step *subagentStep
	if n := len(s.steps); n > 0 && s.steps[n-1].said && s.steps[n-1].iteration == iteration {
		step = s.steps[n-1]
	} else {
		step = &subagentStep{said: true, iteration: iteration, done: true, started: now}
		s.add(step)
	}
	if len(step.result) < maxSubagentResult {
		step.result += text
	}
	step.ended = now
	words := strings.TrimSpace(step.result)
	step.line = words
	if i := strings.IndexByte(words, '\n'); i >= 0 {
		step.line = words[:i]
	}
	lines := strings.Split(words, "\n")
	s.said = strings.TrimSpace(lines[len(lines)-1])
}

// running is the step a sub-agent is on now, if one has not come back yet.
func (s *subagentRun) running() *subagentStep {
	if s == nil {
		return nil
	}
	for i := len(s.steps) - 1; i >= 0; i-- {
		if !s.steps[i].done {
			return s.steps[i]
		}
	}
	return nil
}

// subagentRole is the role a delegation card names: what the sub-agent said it was, else what the
// call asked for, else the tool's default.
func subagentRole(t *toolItem) string {
	if t.sub != nil && t.sub.agent != "" {
		return t.sub.agent
	}
	if role, _ := t.args["agent"].(string); strings.TrimSpace(role) != "" {
		return strings.TrimSpace(role)
	}
	if t.name == "delegate_readonly_task" {
		return "explore"
	}
	return "general"
}

// subagentSummary is the card's header verdict: how much the sub-agent has done.
func subagentSummary(t *toolItem) string {
	var parts []string
	if t.sub != nil {
		parts = append(parts, plural(t.sub.calls, "call"))
		if t.sub.failed > 0 {
			parts = append(parts, fmt.Sprintf("%d failed", t.sub.failed))
		}
		if t.sub.tokens > 0 {
			parts = append(parts, compact(t.sub.tokens)+" tokens")
		}
	}
	switch {
	case backgroundRunning(t):
		parts = append([]string{"in the background"}, parts...)
	case agentStopped(t):
		parts = append([]string{"stopped"}, parts...)
	}
	if len(parts) == 0 {
		if t.done {
			return "done"
		}
		return "starting"
	}
	return strings.Join(parts, " · ")
}

// subagentActivity is the card's body: while it runs, its latest calls, newest last; once done,
// the first line of its report (the whole report is the card's output, shown on a click).
func subagentActivity(ctx renderCtx, t *toolItem, expanded bool) []string {
	rule := ctx.th.Faint.Render("  ⎿ ")
	room := max(ctx.width-4, 8)
	if t.done && !backgroundRunning(t) {
		if expanded || t.isError {
			return nil // the full output follows
		}
		for _, line := range strings.Split(t.result, "\n") {
			if line = strings.TrimSpace(line); line != "" {
				return []string{rule + ctx.th.Body.Render(ansi.Truncate(line, room, "…"))}
			}
		}
		return nil
	}
	if t.sub == nil {
		return nil
	}
	var lines []string
	if t.sub.said != "" {
		lines = append(lines, rule+ctx.th.Body.Render(ansi.Truncate("“"+t.sub.said+"”", room, "…")))
	}
	for _, call := range t.sub.recent {
		lines = append(lines, rule+ctx.th.Faint.Render(ansi.Truncate(call, room, "…")))
	}
	return lines
}
