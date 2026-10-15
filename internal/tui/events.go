package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

// handleAgent turns one agent message into transcript changes.
func (m *Model) handleAgent(msg any) {
	switch msg := msg.(type) {
	case acp.TextChunk:
		m.retrying = ""
		if m.current == nil {
			m.current = &assistantItem{open: true}
			m.tr.add(m.current)
		}
		m.current.append(msg.Text)
		m.stats.text(len(msg.Text), time.Now())
	case acp.UserChunk:
		// A loaded session's history: the person's message, then whatever followed it.
		m.closeAssistant()
		m.tr.add(&userItem{text: msg.Text})
	case acp.PermissionRequest:
		m.approval = &approval{req: msg}
	case acp.AgentEvent:
		m.handleEvent(msg.Event)
	case acp.Exited:
		m.phase = failed
		text := "The agent stopped."
		if msg.Err != nil {
			text = "The agent exited: " + msg.Err.Error()
		}
		if tail := lastLines(msg.Stderr, 6); tail != "" {
			text += "\n" + tail
		}
		m.notice(noticeError, text)
	}
}

func (m *Model) handleEvent(ev acp.Event) {
	switch ev.Type {
	case "runtime":
		if ev.Event != nil {
			m.handleRuntime(*ev.Event)
		}
	case "compaction":
		m.notice(noticeFaint, fmt.Sprintf("Compacted the conversation: %d → %d messages.", ev.MessagesBefore, ev.MessagesAfter))
	case "jev-review":
		m.notice(noticeWarn, fmt.Sprintf("Jev disagreed (%s, %.0f%%); asking the agent to check its work.", ev.Outcome, ev.Probability*100))
	}
}

func (m *Model) handleRuntime(ev acp.RuntimeEvent) {
	switch ev.Type {
	case "tool_call":
		m.closeAssistant()
		m.stats.tool(ev.ToolName)
		t := &toolItem{id: ev.ToolCallID, name: ev.ToolName, args: ev.Arguments, started: time.Now()}
		m.tools[ev.ToolCallID] = t
		m.tr.add(t)
	case "tool_result":
		if ev.IsError {
			m.limits.toolError(time.Now())
		}
		if t := m.tools[ev.ToolCallID]; t != nil {
			t.finish(ev.Content, ev.IsError)
		}
	case "model_turn":
		// One model call's text is one block: the next call's reply (a verification pass, say) is
		// a new paragraph, not a continuation glued onto this one.
		m.closeAssistant()
		m.limits.call(time.Now())
		if ev.Effort != "" || ev.EffortReason != "" {
			effort := ev.Effort
			if effort == "" {
				effort = "default" // the agent chose to leave it to the model
			}
			m.effort = [2]string{effort, ev.EffortReason}
		}
		if a := ev.Allowance; a != nil && a.RemainingRequests != nil && a.RequestLimit != nil {
			m.limits.allowance(*a.RemainingRequests, *a.RequestLimit)
		}
		if ev.Usage != nil {
			m.stats.call(ev.Usage.InputTokens, ev.Usage.OutputTokens, time.Now())
			m.turnUsage.input += ev.Usage.InputTokens
			m.turnUsage.output += ev.Usage.OutputTokens
			m.usage.input += ev.Usage.InputTokens
			m.usage.output += ev.Usage.OutputTokens
		}
	case "provider_retry":
		if ev.Reason == "rate_limit" {
			m.limits.rateLimited(time.Now())
		}
		if ev.Reason == "rate_limit" && m.session.Info.Model != "" {
			if m.limited == nil {
				m.limited = map[string]time.Time{}
			}
			m.limited[m.session.Info.Model] = time.Now()
		}
		m.retrying = fmt.Sprintf("retry %d/%d: %s", ev.NextAttempt, ev.MaxAttempts, ev.Reason)
		m.retryStart, m.retryDelay = time.Now(), time.Duration(ev.DelayMs)*time.Millisecond
	case "context_shrunk":
		// The model said the conversation was too long; the agent made it shorter and carried on.
		what := "old tool output shortened"
		if ev.Step >= 2 {
			what = "the earlier conversation set aside"
		}
		m.notice(noticeFaint, "Too long for this model: "+what+", and the turn goes on.")
	case "runtime_stop":
		if ev.Status != "completed" && ev.Status != "cancelled" {
			if summary := stopSummary(ev.Summary); summary != "" {
				m.notice(noticeWarn, summary)
			}
		}
	}
}

// closeAssistant ends the streaming reply, so the next text starts a new block below any tool call.
func (m *Model) closeAssistant() {
	if m.current != nil {
		m.current.open = false
		m.current = nil
	}
}

// stopSummary is the runtime's verdict without the reply it quotes, which is already on screen.
func stopSummary(summary string) string {
	verdict, _, _ := strings.Cut(summary, "The agent reported:")
	return strings.TrimSpace(verdict)
}

func lastLines(text string, n int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}
