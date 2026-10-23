package tui

import (
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func subagentEvent(parent, agent string, ev acp.RuntimeEvent) acp.Event {
	return acp.Event{Type: "subagent", ParentToolCallID: parent, Agent: agent, Event: &ev}
}

func TestASubagentsWorkIsShownUnderItsDelegationCardWhileItRuns(t *testing.T) {
	m, _ := newTestModel(t)
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_readonly_task", Arguments: map[string]any{"task": "find the router", "agent": "explore"}})
	if s := screen(m); !strings.Contains(s, "agent · explore") || !strings.Contains(s, "starting") {
		t.Fatalf("a new delegation card names its role and says it is starting:\n%s", s)
	}
	for i, path := range []string{"a.go", "b.go", "c.go", "d.go"} {
		id := string(rune('1' + i))
		m.handleEvent(subagentEvent("d1", "explore", acp.RuntimeEvent{Type: "tool_call", ToolCallID: id, ToolName: "read_file", Arguments: map[string]any{"path": path}}))
		m.handleEvent(subagentEvent("d1", "explore", acp.RuntimeEvent{Type: "tool_result", ToolCallID: id, ToolName: "read_file", IsError: path == "b.go"}))
	}
	m.handleEvent(subagentEvent("d1", "explore", acp.RuntimeEvent{Type: "model_turn", Usage: &acp.Usage{InputTokens: 1000, OutputTokens: 200}}))
	s := screen(m)
	for _, want := range []string{"4 calls", "1 failed", "read file d.go", "read file b.go"} {
		if !strings.Contains(s, want) {
			t.Errorf("running card lacks %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "read file a.go") {
		t.Errorf("only the latest %d calls are listed:\n%s", recentSubagentCalls, s)
	}
	if m.usage.input != 1000 || m.usage.output != 200 {
		t.Errorf("a sub-agent's tokens count toward the session: %+v", m.usage)
	}

	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "d1", ToolName: "delegate_readonly_task", Content: "The router is in server/routes.go:12."})
	s = screen(m)
	if strings.Contains(s, "read file d.go") {
		t.Errorf("a finished card folds its activity away:\n%s", s)
	}
	if !strings.Contains(s, "4 calls") || !strings.Contains(s, "The router is in") {
		t.Errorf("a finished card keeps the count and how the report begins:\n%s", s)
	}
}

func TestASubagentEventForAnUnknownCallStillCountsItsSpend(t *testing.T) {
	m, _ := newTestModel(t)
	m.handleEvent(subagentEvent("gone", "general", acp.RuntimeEvent{Type: "model_turn", Usage: &acp.Usage{InputTokens: 10, OutputTokens: 5}}))
	if m.usage.input != 10 || m.usage.output != 5 {
		t.Fatalf("spend is the session's whether or not the card is on screen: %+v", m.usage)
	}
}

func TestABackgroundSubagentsCardFollowsItsThreadUntilTheReport(t *testing.T) {
	m, _ := newTestModel(t)
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_readonly_task", Arguments: map[string]any{"task": "map the API", "background": true}})
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "t-1", ParentToolCallID: "d1", Agent: "explore", Status: "running", Background: true}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "d1", ToolName: "delegate_readonly_task", Content: "Started explore sub-agent t-1 in the background."})
	m.handleEvent(subagentEvent("d1", "explore", acp.RuntimeEvent{Type: "tool_call", ToolCallID: "x", ToolName: "grep_files", Arguments: map[string]any{"query": "route"}}))
	s := screen(m)
	if !strings.Contains(s, "in the background") || !strings.Contains(s, "grep files") {
		t.Fatalf("a background card keeps showing the work after its call returned:\n%s", s)
	}
	m.phase = ready
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "t-1", ParentToolCallID: "d1", Agent: "explore", Status: "done", Background: true, Report: "The API is in api/routes.go."}})
	s = screen(m)
	if strings.Contains(s, "in the background") || !strings.Contains(s, "The API is in api/routes.go.") || !strings.Contains(s, "its report reaches Friday") {
		t.Fatalf("a finished background card shows its report:\n%s", s)
	}
}
