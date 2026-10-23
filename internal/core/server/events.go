package server

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
)

// publish sends one notice of a session: as the standard update an editor renders (text and tool
// calls), and, to a client that opted in, as the `_archymedes/event` the interface reads.
func (s *Server) publish(sessionID string, n agents.Notice) {
	if n.Kind == "runtime" && n.Event != nil {
		if update := standardUpdate(*n.Event); update != nil {
			s.notify("session/update", map[string]any{"sessionId": sessionID, "update": update})
		}
		if n.Event.Type == loop.EventDelta {
			return // assistant text already went as agent_message_chunk
		}
	}
	if !s.events.Load() {
		return
	}
	if event := extensionEvent(n); event != nil {
		s.notify("_archymedes/event", map[string]any{"sessionId": sessionID, "event": event})
	}
}

// extensionEvent is a notice as an ArchymedesEvent (core/cli/agent.ts), or nil.
func extensionEvent(n agents.Notice) map[string]any {
	switch n.Kind {
	case "runtime":
		if n.Event == nil {
			return nil
		}
		return map[string]any{"type": "runtime", "event": n.Event}
	case "subagent":
		return map[string]any{"type": "subagent", "parentToolCallId": n.ParentToolCallID, "agent": n.Agent, "event": n.Event}
	case "thread":
		return map[string]any{"type": "thread", "thread": n.Thread}
	case "compaction":
		if n.Event == nil {
			return nil
		}
		return map[string]any{"type": "compaction", "tokensBefore": n.Event.TokensBefore, "messagesBefore": n.Event.MessagesBefore, "messagesAfter": n.Event.MessagesAfter}
	case "steering_unread":
		return map[string]any{"type": "steering_unread", "messages": n.Messages}
	case "rules_problems":
		return map[string]any{"type": "rules_problems", "problems": n.Problems}
	}
	return nil
}

// standardUpdate is a runtime event as ACP's own session/update (acpUpdateFor in acp.ts).
func standardUpdate(ev loop.Event) map[string]any {
	switch ev.Type {
	case loop.EventDelta:
		return map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": ev.Text}}
	case loop.EventToolCall:
		return map[string]any{"sessionUpdate": "tool_call", "toolCallId": ev.ToolCallID, "title": toolTitle(ev.ToolName, ev.Arguments), "kind": toolKind(ev.ToolName), "status": "in_progress", "rawInput": ev.Arguments}
	case loop.EventToolResult:
		status := "completed"
		if ev.IsError {
			status = "failed"
		}
		return map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": ev.ToolCallID, "status": status,
			"content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": ev.Content}}}}
	}
	return nil
}

var (
	kindRead    = regexp.MustCompile(`^(read_file|list_files)$`)
	kindEdit    = regexp.MustCompile(`^(write_file|edit_file)$`)
	kindSearch  = regexp.MustCompile(`^(glob_files|grep_files|tool_search)$`)
	kindExecute = regexp.MustCompile(`^(run_command)$`)
	kindThink   = regexp.MustCompile(`^(todo_write|todo_read|delegate_task|delegate_readonly_task|wait_agents|send_agent|close_agent)$`)
)

func toolKind(name string) string {
	switch {
	case kindRead.MatchString(name):
		return "read"
	case kindEdit.MatchString(name):
		return "edit"
	case kindSearch.MatchString(name):
		return "search"
	case kindExecute.MatchString(name):
		return "execute"
	case kindThink.MatchString(name):
		return "think"
	}
	return "other"
}

func toolTitle(name string, args map[string]any) string {
	label := strings.TrimSpace(strings.ReplaceAll(name, "_", " "))
	for _, key := range []string{"path", "command", "pattern", "query", "task"} {
		if v, ok := args[key].(string); ok && strings.TrimSpace(v) != "" {
			if r := []rune(v); len(r) > 120 {
				v = string(r[:120])
			}
			return fmt.Sprintf("%s: %s", label, v)
		}
	}
	return label
}
