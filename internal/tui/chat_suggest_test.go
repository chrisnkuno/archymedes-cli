package tui

import (
	"context"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// judgingAgent is an engine with Jev: it weighs typing options with weigh.
type judgingAgent struct {
	*fakeAgent
	weigh func(input string, options []string) ([]float64, float64)
	asked []string
}

func (j *judgingAgent) Suggest(_ context.Context, input string, options []string) ([]float64, float64, bool) {
	j.asked = append(j.asked, input)
	scores, none := j.weigh(input, options)
	return scores, none, true
}

// finishedTurn runs one turn that edited auth.go, to its end.
func finishedTurn(t *testing.T, m *Model) {
	t.Helper()
	typeText(m, "add a refresh")
	cmd := press(m, tea.KeyEnter, 0)
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "edit_file", Arguments: map[string]any{"path": "auth.go"}}}}})
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "tool_result", ToolCallID: "c1", ToolName: "edit_file", Content: "Edited auth.go (1 replacement)."}}}})
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "edit_notes", ToolCallID: "c1", Path: "auth.go", Notes: []acp.EditNote{
		{Text: "Leaves a TODO behind", Kind: "fact"}, {Text: "May leave an error unhandled", Kind: "judged", Score: 0.82}}}}})
	// Steps sent while the turn still runs are stale by the time it ends.
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "suggestions", Steps: []acp.Suggestion{{Text: "stale"}}}}})
	m.Update(agentMsg{acp.TextChunk{Text: "Added Refresh."}})
	run(m, cmd)
}

var steps = []acp.Suggestion{
	{Text: "Run the tests that cover auth.go", Why: "the change has not been checked yet", Score: 0.9, Source: "rule"},
	{Text: "Handle a missing token in Refresh", Why: "it returns nil for every token", Score: 0.71, Source: "model"},
	{Text: "/review", Why: "read the change before it goes further", Source: "rule"},
}

func TestNextStepsFollowATurnAndGoInTheInputByKey(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 30})
	finishedTurn(t, m)
	if len(m.nextSteps) != 0 {
		t.Fatal("steps sent during the turn were kept")
	}
	s := screen(m)
	for _, want := range []string{"⚑ Leaves a TODO behind", "⚑ May leave an error unhandled · jev 82%"} {
		if !strings.Contains(s, want) {
			t.Errorf("edit notes: no %q\n%s", want, s)
		}
	}
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "suggestions", Steps: steps}}})
	s = screen(m)
	for _, want := range []string{"alt+1/tab › Run the tests that cover auth.go · the change has not been checked yet  90%", "alt+2", "› /review"} {
		if !strings.Contains(s, want) {
			t.Errorf("next steps: no %q\n%s", want, s)
		}
	}
	press(m, '2', tea.ModAlt)
	if m.input.value() != "Handle a missing token in Refresh" {
		t.Fatalf("alt+2 put %q", m.input.value())
	}
	press(m, tea.KeyTab, 0) // tab moves on to the next step
	if m.input.value() != "/review" {
		t.Fatalf("tab put %q", m.input.value())
	}
	m.input.take()
	press(m, tea.KeyEnter, 0)
	press(m, tea.KeyTab, 0)
	typeText(m, "")
	if m.input.value() != steps[0].Text {
		t.Fatalf("tab on an empty input put %q", m.input.value())
	}
	run(m, press(m, tea.KeyEnter, 0))
	if len(m.nextSteps) != 0 || strings.Contains(screen(m), "alt+1") {
		t.Fatal("sending did not clear the steps")
	}
	if agent.prompts[len(agent.prompts)-1] != steps[0].Text {
		t.Fatalf("prompts = %q", agent.prompts)
	}
}

func TestAClickTakesANextStep(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	finishedTurn(t, m)
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "suggestions", Steps: steps}}})
	x, y := cellOf(t, m, "Handle a missing token")
	click(m, x, y)
	if m.input.value() != steps[1].Text {
		t.Fatalf("click put %q", m.input.value())
	}
}

func TestTypingOffersWhatItSeemsHeadedFor(t *testing.T) {
	m, _ := newTestModel(t)
	m.input.history = []string{"explain how the session store saves threads"}
	typeText(m, "review a change for problems")
	run(m, m.lookForHints(typingTickMsg{m.typing.seq}))
	if s := screen(m); !strings.Contains(s, "tab › /review · Review a change") {
		t.Fatalf("no hint for /review:\n%s", s)
	}
	press(m, tea.KeyTab, 0)
	if m.input.value() != "/review " {
		t.Fatalf("tab took %q", m.input.value())
	}
	// An earlier request it begins.
	m.input.take()
	typeText(m, "explain how the sess")
	run(m, m.lookForHints(typingTickMsg{m.typing.seq}))
	press(m, tea.KeyTab, 0)
	if m.input.value() != "explain how the session store saves threads" {
		t.Fatalf("tab took %q", m.input.value())
	}
	// Nothing in common: no hint, and tab does what it did.
	m.input.take()
	typeText(m, "zzzz qqqq")
	run(m, m.lookForHints(typingTickMsg{m.typing.seq}))
	if len(m.shownHints()) != 0 {
		t.Fatalf("hints for nonsense: %+v", m.shownHints())
	}
	// A hint goes stale as soon as the input changes.
	m.input.take()
	typeText(m, "review a change for problems")
	run(m, m.lookForHints(typingTickMsg{m.typing.seq}))
	typeText(m, "!")
	if len(m.shownHints()) != 0 {
		t.Fatal("a hint outlived the input it was for")
	}
}

func TestJevReordersTheHints(t *testing.T) {
	m, fake := newTestModel(t)
	judge := &judgingAgent{fakeAgent: fake, weigh: func(_ string, options []string) ([]float64, float64) {
		scores := make([]float64, len(options))
		for i, o := range options {
			if strings.HasPrefix(o, "/diff") {
				scores[i] = 0.8
			}
		}
		return scores, 0.1
	}}
	m.agent = judge
	typeText(m, "show the change I made")
	run(m, m.lookForHints(typingTickMsg{m.typing.seq}))
	if len(judge.asked) != 1 {
		t.Fatalf("Jev asked %d times", len(judge.asked))
	}
	if h := m.shownHints(); len(h) != 1 || !strings.HasPrefix(h[0].text, "/diff") || !strings.Contains(screen(m), "⟡ tab › /diff") {
		t.Fatalf("hints = %+v\n%s", h, screen(m))
	}
	// An answer for an earlier input is dropped.
	m.hintsRanked(typingRankedMsg{seq: m.typing.seq - 1, input: "old", scores: []float64{1}, pool: []hint{{text: "x"}}})
	if h := m.shownHints(); h[0].text == "x" {
		t.Fatal("a stale ranking replaced the hints")
	}
}
