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

// subagentRun is what one sub-agent has done so far, under the delegation call that started it.
type subagentRun struct {
	agent         string
	calls, failed int
	tokens        int
	recent        []string // its latest calls, oldest first, at most recentSubagentCalls
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
	t.sub.apply(inner)
	t.touch()
}

func (s *subagentRun) apply(ev acp.RuntimeEvent) {
	switch ev.Type {
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
	case "tool_result":
		if ev.IsError {
			s.failed++
		}
	case "model_turn":
		if ev.Usage != nil {
			s.tokens += ev.Usage.InputTokens + ev.Usage.OutputTokens
		}
	}
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
	if t.done {
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
	for _, call := range t.sub.recent {
		lines = append(lines, rule+ctx.th.Faint.Render(ansi.Truncate(call, room, "…")))
	}
	return lines
}
