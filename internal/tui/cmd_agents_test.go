package tui

import (
	"slices"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestAltAHandsWhatIsTypedToANewHelper(t *testing.T) {
	m, agent := newTestModel(t)
	typeText(m, "explore map the API")
	run(m, press(m, 'a', tea.ModAlt))
	if m.input.value() != "" {
		t.Fatalf("the input is taken: %q", m.input.value())
	}
	typeText(m, "review the parser")
	run(m, press(m, 'a', tea.ModAlt))
	agent.mu.Lock()
	got := slices.Clone(agent.commands)
	agent.mu.Unlock()
	if !slices.Contains(got, "spawn:explore map the API") || !slices.Contains(got, "spawn:review the parser") {
		t.Fatalf("each alt+a starts one helper: %v", got)
	}
	if m.phase == busy {
		t.Fatal("starting a helper is not a turn")
	}
}

func TestAgentWithNoTaskOpensThePickerAndStartsTheChosenRole(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	typeText(m, "map the API") // what was typed becomes its task
	run(m, m.cmdAgent(""))
	_, ok := m.overlay.(*newHelperDialog)
	if !ok {
		t.Fatalf("/agent alone opens the picker, got %T", m.overlay)
	}
	s := screen(m)
	for _, want := range []string{"New helper", "auto", "explore", "read-only", "find where/how something works", "general", "changes files", "map the API"} {
		if !strings.Contains(s, want) {
			t.Errorf("the picker lacks %q:\n%s", want, s)
		}
	}
	run(m, press(m, tea.KeyDown, 0)) // explore
	run(m, press(m, tea.KeyEnter, 0))
	agent.mu.Lock()
	got := slices.Clone(agent.commands)
	agent.mu.Unlock()
	if !slices.Contains(got, "spawn:explore map the API") || m.overlay != nil || m.input.value() != "" {
		t.Fatalf("enter starts the chosen role on the task, taking it from the box: %v, overlay %T, input %q", got, m.overlay, m.input.value())
	}

	// Without a task nothing starts.
	run(m, m.cmdAgent(""))
	run(m, press(m, tea.KeyEnter, 0))
	agent.mu.Lock()
	defer agent.mu.Unlock()
	if n := len(agent.commands); agent.commands[n-1] != "roles:" {
		t.Fatalf("nothing starts without a task: %v", agent.commands)
	}
}

func TestAHelperThePersonStartedGetsALiveCard(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	th := &acp.ThreadInfo{ID: "t-1", ParentToolCallID: "user:t-x", Agent: "explore", Status: "running", Background: true, Brief: "map the API"}
	m.handleThread(th)
	card := m.tools["user:t-x"]
	if card == nil || !backgroundRunning(card) {
		t.Fatalf("its first thread event makes its card, running: %+v", card)
	}
	if s := screen(m); !strings.Contains(s, "agent · explore") {
		t.Fatalf("the card names its role:\n%s", s)
	}
	m.handleSubagent(acp.Event{ParentToolCallID: "user:t-x", Event: &acp.RuntimeEvent{Type: "tool_call", ToolCallID: "k1", ToolName: "read_file", Arguments: map[string]any{"path": "api.go"}}})
	if card.sub.calls != 1 {
		t.Fatalf("its work lands on its card: %+v", card.sub)
	}
	if len(m.workingAgents()) != 1 {
		t.Fatal("the rail and the Inspector see it at work")
	}
	m.handleThread(&acp.ThreadInfo{ID: "t-1", ParentToolCallID: "user:t-x", Agent: "explore", Status: "done", Background: true, Report: "The API has 3 routes."})
	if card.result != "The API has 3 routes." || backgroundRunning(card) {
		t.Fatalf("its report replaces the card's output when it ends: %q", card.result)
	}
	if n := strings.Count(screen(m), "agent · explore"); n != 1 {
		t.Fatalf("one card, not one per event: %d", n)
	}
}

func TestOnlyUserCallIdsMakeACard(t *testing.T) {
	m, _ := newTestModel(t)
	m.handleThread(&acp.ThreadInfo{ID: "t-2", ParentToolCallID: "c9", Agent: "general", Status: "running"})
	if m.tools["c9"] != nil {
		t.Fatal("a model's delegation has its own card from its tool call")
	}
}
