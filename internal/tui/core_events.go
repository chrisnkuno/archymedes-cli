package tui

import (
	"fmt"
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// agentBatch is several agent messages delivered together, so a burst of stream chunks is one
// render, not one per token. The screen composites in full each frame, so coalescing is the
// difference between smooth streaming and a frame per character.
type agentBatch struct{ msgs []any }

// forward delivers the agent's messages to the model, coalescing a burst into one render.
func (m *Model) forward(agent Agent) {
	if m.sender == nil {
		return // tests deliver the agent's messages themselves
	}
	send := m.sender
	ch := agent.Messages()
	go func() {
		for first := range ch {
			// Take whatever else is already waiting, so a fast stream renders once per drain rather
			// than once per chunk. Bounded by what has already arrived: nothing is held back waiting.
			batch := []any{first}
			draining := true
			for draining {
				select {
				case next, ok := <-ch:
					if !ok {
						draining = false
						break
					}
					batch = append(batch, next)
				default:
					draining = false
				}
			}
			send(agentBatch{msgs: batch})
		}
	}()
}

// handleAgentMsgs applies a batch of agent messages, then asks for one render. A turn's end is kept
// in order: it arrives last in its batch, so the messages before it are shown before the turn wraps.
func (m *Model) handleAgentMsgs(msgs []any) tea.Cmd {
	var cmds []tea.Cmd
	for _, msg := range msgs {
		if end, ok := msg.(acp.TurnEnded); ok {
			cmds = append(cmds, m.finishTurn(promptDoneMsg{stop: end.StopReason}))
			continue
		}
		m.handleAgent(msg)
	}
	return tea.Batch(append(cmds, m.flushNotifications())...)
}

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
		m.queueApproval(&approval{req: msg})
	case acp.QuestionRequest:
		m.closeAssistant() // the question follows what was said, not inside it
		m.queueApproval(&approval{ask: &msg})
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
		m.contextUsed = 0
		if ev.MessagesBefore == 0 && ev.TokensBefore > 0 {
			// Claude Code compacts its own conversation and says only how long it was.
			m.notice(noticeFaint, fmt.Sprintf("Compacted the conversation (it was %s tokens)", compact(ev.TokensBefore)))
			break
		}
		m.notice(noticeFaint, fmt.Sprintf("Compacted the conversation: %d → %d messages", ev.MessagesBefore, ev.MessagesAfter))
	case "rules_problems":
		m.notice(noticeWarn, "Some command rules or agent roles were left out:\n"+strings.Join(ev.Problems, "\n"))
	case "subagent":
		m.handleSubagent(ev)
	case "thread":
		m.handleThread(ev.Thread)
	case "steering_unread":
		// The turn ended before reading these: they go first in the queue, as turns of their own.
		m.queue = append(slices.Clone(ev.Messages), m.queue...)
	case "suggestions":
		m.takeSuggestions(ev.Steps)
	case "edit_notes":
		m.noteEdit(ev)
	case "jev-review":
		m.notice(noticeWarn, fmt.Sprintf("Jev disagreed (%s, %.0f%%); asking the agent to check its work", ev.Outcome, ev.Probability*100))
	}
}

func (m *Model) handleRuntime(ev acp.RuntimeEvent) {
	switch ev.Type {
	case "tool_compose":
		ev := ev
		m.composing = &ev
	case "tool_call":
		m.composing = nil
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
		m.composing = nil
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
			m.contextUsed = ev.Usage.InputTokens + ev.Usage.OutputTokens
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
	case "test_first":
		m.testFirst = ev.State
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
