package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

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

// TestTheEnginesTokenCountIsTheCardsCount: a thread's usage is the whole of it (steps before a
// restart, steps whose events never arrived), so it replaces a smaller count on the card.
func TestTheEnginesTokenCountIsTheCardsCount(t *testing.T) {
	m, _ := newTestModel(t)
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_readonly_task", Arguments: map[string]any{"task": "find", "agent": "explore"}})
	m.handleEvent(subagentEvent("d1", "explore", acp.RuntimeEvent{Type: "model_turn", Usage: &acp.Usage{InputTokens: 100, OutputTokens: 20}}))
	m.handleThread(&acp.ThreadInfo{ID: "t-1", ParentToolCallID: "d1", Agent: "explore", Status: "done", Usage: &acp.Usage{InputTokens: 12000, OutputTokens: 400}})
	if s := screen(m); !strings.Contains(s, "12.4k tokens") {
		t.Fatalf("the card does not show the engine's count:\n%s", s)
	}
}

func TestABackgroundSubagentKeepsItsCardAfterTheTurnEnds(t *testing.T) {
	m, _ := newTestModel(t)
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"task": "summarize", "agent": "Explore"}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "d1", ToolName: "delegate_task", Content: "Working in the background"})
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "a1", ParentToolCallID: "d1", Agent: "Explore", Status: "running", Background: true}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "x1", ToolName: "read_file", Arguments: map[string]any{"path": "x.go"}})
	m.finishTurn(promptDoneMsg{stop: "end_turn"}) // the turn ends before the sub-agent does anything

	if _, kept := m.tools["x1"]; kept {
		t.Error("an unfinished ordinary call is let go when its turn ends")
	}
	m.handleEvent(subagentEvent("d1", "Explore", acp.RuntimeEvent{Type: "tool_call", ToolCallID: "r1", ToolName: "read_file", Arguments: map[string]any{"path": "add.go"}}))
	m.handleEvent(subagentEvent("d1", "Explore", acp.RuntimeEvent{Type: "tool_result", ToolCallID: "r1", ToolName: "read_file", Content: "package main"}))
	m.handleEvent(subagentEvent("d1", "Explore", acp.RuntimeEvent{Type: "assistant_delta", Text: "add.go adds two ints.", Iteration: 2}))
	if s := screen(m); !strings.Contains(s, "1 call") || !strings.Contains(s, "add.go adds two ints.") {
		t.Fatalf("the card follows the sub-agent after its turn:\n%s", s)
	}
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "a1", ParentToolCallID: "d1", Agent: "Explore", Status: "done", Background: true, Report: "add.go adds two ints."}})
	if card := m.tools["d1"]; card == nil || backgroundRunning(card) || card.result != "add.go adds two ints." {
		t.Fatalf("its end lands on the card: %+v", card)
	}
	m.finishTurn(promptDoneMsg{stop: "end_turn"})
	if len(m.tools) != 0 {
		t.Errorf("a finished background card is let go at the next turn's end: %d kept", len(m.tools))
	}
}

func TestAStoppedSubagentIsDrawnStoppedAndNothingSpinsOn(t *testing.T) {
	m, _ := newTestModel(t)
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"task": "sleep six times", "agent": "general"}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "d1", ToolName: "delegate_task", Content: "Working in the background"})
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "a1", ParentToolCallID: "d1", Agent: "general", Status: "running", Background: true}})
	m.handleEvent(subagentEvent("d1", "general", acp.RuntimeEvent{Type: "tool_call", ToolCallID: "r1", ToolName: "run_command", Arguments: map[string]any{"command": "sleep 5"}}))
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "a1", ParentToolCallID: "d1", Agent: "general", Status: "cancelled", Background: true, Report: "Stopped before it finished."}})

	card := m.tools["d1"]
	if st := card.sub.steps[0]; !st.done || !st.isError {
		t.Fatalf("the command it was running ends with it: %+v", st)
	}
	s := screen(m)
	if !strings.Contains(s, "■") || !strings.Contains(s, "stopped") || strings.Contains(s, "✓  agent") {
		t.Errorf("a stopped sub-agent is drawn stopped, not done:\n%s", s)
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	if s := screen(m); !strings.Contains(s, "stopped after") || !strings.Contains(s, "Stopped before it finished.") {
		t.Errorf("the Inspector says it was stopped:\n%s", s)
	}
}
