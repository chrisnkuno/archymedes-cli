package tui

import (
	"slices"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestRightOnAnEmptyInputOpensTheInspectorOnTheSubagentAtWork(t *testing.T) {
	m := railModel(t, 120)
	m.phase = busy
	startSubagent(m, "d1", 4)
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	a, ok := m.activeWindow().(*inspectApp)
	if !ok {
		t.Fatalf("→ should open the Inspector, got %T", m.activeWindow())
	}
	s := screen(m)
	for _, want := range []string{"Inspector", "agent · general", "make A return two everywhere", "Timeline", "edit file", "+1 −1", "running"} {
		if !strings.Contains(s, want) {
			t.Errorf("the Inspector lacks %q:\n%s", want, s)
		}
	}
	// → into the timeline lands on the newest call, which is what is happening.
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	if !a.onSteps || a.step != 3 {
		t.Fatalf("→ should step onto the newest call: onSteps %v step %d", a.onSteps, a.step)
	}
	// ← back to the list, ← again back to Chat.
	m.Update(tea.KeyPressMsg{Code: tea.KeyLeft})
	m.Update(tea.KeyPressMsg{Code: tea.KeyLeft})
	if m.activeWindow() != nil {
		t.Fatalf("← from the list goes back to Chat, got %T", m.activeWindow())
	}
}

func TestRightWhileTypingMovesTheCursorInstead(t *testing.T) {
	m := railModel(t, 120)
	startSubagent(m, "d1", 2)
	typeText(m, "ab")
	m.Update(tea.KeyPressMsg{Code: tea.KeyLeft})
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	if m.activeWindow() != nil {
		t.Fatal("→ in a message being typed is the cursor's, not the Inspector's")
	}
}

func TestRightWithNothingToInspectSaysSo(t *testing.T) {
	m := railModel(t, 120)
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	if m.activeWindow() != nil || len(m.toasts) == 0 {
		t.Fatal("with no sub-agent or edit, → explains rather than opening an empty window")
	}
}

func TestRightOnASelectedCardInspectsThatCard(t *testing.T) {
	m := railModel(t, 120)
	landEdit(m)
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "r1", ToolName: "read_file", Arguments: map[string]any{"path": "f.go"}}))
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "r1", ToolName: "read_file", Content: "package f"}))
	m.Update(tea.KeyPressMsg{Code: tea.KeyUp}) // onto the newest card: the read
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	if _, ok := m.activeWindow().(*inspectApp); !ok {
		t.Fatalf("→ on a card opens the Inspector, got %T", m.activeWindow())
	}
	s := screen(m)
	if !strings.Contains(s, "read file") || !strings.Contains(s, "Output") || !strings.Contains(s, "package f") {
		t.Fatalf("the Inspector should show the card it was opened on, in full:\n%s", s)
	}
}

// TestInvariantSubagentTimelineIsBoundedAndMatched: every result finds its call, steps never pass
// their bound, and the count of calls is never less than the steps kept.
func TestInvariantSubagentTimelineIsBoundedAndMatched(t *testing.T) {
	m := railModel(t, 120)
	m.phase = busy
	startSubagent(m, "d1", maxSubagentSteps+57)
	sub := m.tools["d1"].sub
	if len(sub.steps) != maxSubagentSteps || sub.dropped != 57 || sub.calls != maxSubagentSteps+57 {
		t.Fatalf("steps %d dropped %d calls %d", len(sub.steps), sub.dropped, sub.calls)
	}
	for i, st := range sub.steps[:len(sub.steps)-1] {
		if !st.done {
			t.Fatalf("step %d (%s) never matched its result", i, st.id)
		}
	}
	if sub.running() != sub.steps[len(sub.steps)-1] {
		t.Fatal("the running step is the last one")
	}
	big := strings.Repeat("x", maxSubagentResult*2)
	m.handleEvent(subagentEvent("d1", "general", acp.RuntimeEvent{Type: "tool_result", ToolCallID: sub.steps[len(sub.steps)-1].id, Content: big}))
	if got := len(sub.steps[len(sub.steps)-1].result); got > maxSubagentResult+64 {
		t.Fatalf("a step's output is kept to its bound: %d bytes", got)
	}
}

func TestASubagentsEditReachesTheRail(t *testing.T) {
	m := railModel(t, 140)
	m.phase = busy
	startSubagent(m, "d1", 3)
	if m.rail.latest == nil || m.rail.latest.who != "general" || m.rail.latest.item != m.tools["d1"] {
		t.Fatalf("a sub-agent's edit is the latest edit, under its card: %+v", m.rail.latest)
	}
	if s := screen(m); !strings.Contains(s, "Agents") || !strings.Contains(s, "read file f.go") {
		t.Fatalf("the rail shows the sub-agent at work and its current call:\n%s", s)
	}
}

func TestASubagentsWordsShowLiveOnItsCardAndInTheInspector(t *testing.T) {
	m := railModel(t, 140)
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"task": "audit", "brief": "Read every handler and list the unchecked inputs.", "agent": "Explore"}})
	say := func(text string, iteration int) {
		m.handleEvent(subagentEvent("d1", "Explore", acp.RuntimeEvent{Type: "assistant_delta", Text: text, Iteration: iteration}))
	}
	say("Starting with ", 1) // streamed: pieces of one call make one entry
	say("the handlers.", 1)
	m.handleEvent(subagentEvent("d1", "Explore", acp.RuntimeEvent{Type: "tool_call", ToolCallID: "r1", ToolName: "read_file", Arguments: map[string]any{"path": "h.go"}}))
	m.handleEvent(subagentEvent("d1", "Explore", acp.RuntimeEvent{Type: "tool_result", ToolCallID: "r1", ToolName: "read_file", Content: "package h"}))
	say("h.go trusts its query string.", 2)

	sub := m.tools["d1"].sub
	if len(sub.steps) != 3 || !sub.steps[0].said || sub.steps[0].result != "Starting with the handlers." || sub.calls != 1 {
		t.Fatalf("steps: %d, first %+v, calls %d", len(sub.steps), sub.steps[0], sub.calls)
	}
	if s := screen(m); !strings.Contains(s, "h.go trusts its query string.") {
		t.Errorf("the card shows what it last said:\n%s", s)
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	s := screen(m)
	for _, want := range []string{"Brief", "Read every handler", "said", "Starting with the handlers.", "read file h.go", "h.go trusts its query string."} {
		if !strings.Contains(s, want) {
			t.Errorf("the Inspector lacks %q:\n%s", want, s)
		}
	}
}

func TestTheInspectorStopsAndMessagesASubagent(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 36})
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"task": "audit", "agent": "Explore"}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "d1", ToolName: "delegate_task", Content: "Working in the background"})
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "a4d8", ParentToolCallID: "d1", Agent: "Explore", Status: "running", Background: true, Model: "claude"}})
	m.handleEvent(subagentEvent("d1", "Explore", acp.RuntimeEvent{Type: "model_turn", Model: "claude-haiku-4-5", Usage: &acp.Usage{InputTokens: 10, OutputTokens: 5}}))
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	s := screen(m)
	for _, want := range []string{"claude-haiku-4-5", "x stop", "m message"} {
		if !strings.Contains(s, want) {
			t.Errorf("the Inspector lacks %q:\n%s", want, s)
		}
	}

	run(m, press(m, 'x', 0))
	run(m, press(m, 'm', 0))
	typeText(m, "also check mul.go")
	run(m, press(m, tea.KeyEnter, 0))
	agent.mu.Lock()
	got := slices.Clone(agent.commands)
	agent.mu.Unlock()
	if !slices.Contains(got, "agent-stop:a4d8") || !slices.Contains(got, "agent-send:a4d8 also check mul.go") {
		t.Fatalf("x and m reach the engine under its thread id: %v", got)
	}

	// Once it has finished: nothing to stop, but it can still be told something.
	m.handleEvent(acp.Event{Type: "thread", Thread: &acp.ThreadInfo{ID: "a4d8", ParentToolCallID: "d1", Agent: "Explore", Status: "done", Background: true, Report: "ok"}})
	if s := screen(m); strings.Contains(s, "x stop") || !strings.Contains(s, "m message") {
		t.Errorf("a finished sub-agent offers a message, not a stop:\n%s", s)
	}
}
