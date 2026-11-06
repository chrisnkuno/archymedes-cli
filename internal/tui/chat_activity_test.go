package tui

import (
	"slices"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// lookAgain is one turn of the activity clock: the interface asks the engine and reads the answer.
func lookAgain(m *Model) { run(m, func() tea.Msg { return activityTickMsg{} }) }

func setActivity(agent *fakeAgent, all ...acp.Activity) {
	agent.mu.Lock()
	agent.activity = all
	agent.mu.Unlock()
}

func sentCommands(agent *fakeAgent) []string {
	agent.mu.Lock()
	defer agent.mu.Unlock()
	return slices.Clone(agent.commands)
}

// hung is a foreground command that has printed nothing and used no CPU for six minutes.
func hung(callID string) acp.Activity {
	now := time.Now()
	return acp.Activity{ID: "fg1", CallID: callID, Command: "make integration", Dir: "/tmp/project", Pid: 4242, Status: "running",
		StartedAt: now.Add(-7 * time.Minute).UnixMilli(), ElapsedMs: (7 * time.Minute).Milliseconds(),
		LastOutputAt: now.Add(-6 * time.Minute).UnixMilli(), QuietMs: (6 * time.Minute).Milliseconds(), CPU: 0, CPUKnown: true, Stuck: true,
		Tail: []string{"waiting for db on :5432", "retrying in 1s"}}
}

// TestAHungCommandLooksStuckAndItsViewStopsIt drives the model through a hung foreground command:
// the engine's reading marks it stuck on its card and in the rail, enter on the card opens what is
// going on, and x stops it.
func TestAHungCommandLooksStuckAndItsViewStopsIt(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 36})
	m.phase = busy
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "run_command", Arguments: map[string]any{"command": "make integration"}}))
	setActivity(agent, hung("c1"))
	lookAgain(m)

	s := screen(m)
	if strings.Count(s, "looks stuck") < 2 {
		t.Fatalf("the card and the rail both say it looks stuck:\n%s", s)
	}
	if !m.enterTranscript() {
		t.Fatal("no block to stand on")
	}
	run(m, press(m, tea.KeyEnter, 0))
	s = screen(m)
	for _, want := range []string{"What's going on", "$ make integration", "pid 4242", "CPU 0.0%", "last printed 6m00s ago", "retrying in 1s", "waiting for db on :5432", "looks stuck", "x stop", "r restart"} {
		if !strings.Contains(s, want) {
			t.Errorf("the view lacks %q:\n%s", want, s)
		}
	}
	run(m, press(m, 'x', 0))
	if got := sentCommands(agent); !slices.Contains(got, "command-stop:c1") {
		t.Fatalf("x stops it by its call: %v", got)
	}
}

func TestABackgroundCommandOpensFromTheRailOnASecondClickAndRestarts(t *testing.T) {
	m := railModel(t, 140)
	agent := m.agent.(*fakeAgent)
	m.phase = busy
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "b1", ToolName: "run_command", Arguments: map[string]any{"command": "npm run dev", "background": true}}))
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "b1", ToolName: "run_command",
		Content: "Started cmd1 in the background (pid 42): npm run dev\ncmd1 running · 2s · 120 bytes\nlistening on :3000\n[next: since=120]"}))
	setActivity(agent, acp.Activity{ID: "cmd1", Command: "npm run dev", Dir: "/tmp/project", Pid: 42, Background: true, Status: "running",
		ElapsedMs: 61_000, LastOutputAt: time.Now().Add(-3 * time.Second).UnixMilli(), QuietMs: 3000, CPU: 12.5, CPUKnown: true,
		Tail: []string{"listening on :3000", "GET / 200"}})
	lookAgain(m)
	if s := screen(m); !strings.Contains(s, "⎿ GET / 200") {
		t.Fatalf("the rail shows the last line the engine read:\n%s", s)
	}

	x, y := cellOf(t, m, "cmd1 npm run dev")
	click(m, x, y)
	if _, open := windowOf[*watchApp](m); open {
		t.Fatal("a first click selects the row; it does not open")
	}
	run(m, click(m, x, y))
	if _, open := windowOf[*watchApp](m); !open {
		t.Fatalf("a second click opens what is going on:\n%s", screen(m))
	}
	s := screen(m)
	for _, want := range []string{"$ npm run dev", "pid 42", "running 1m01s", "CPU 12.5%", "last printed 3s ago", "GET / 200", "in /tmp/project"} {
		if !strings.Contains(s, want) {
			t.Errorf("the view lacks %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "looks stuck") {
		t.Errorf("a busy command is not stuck:\n%s", s)
	}
	run(m, press(m, 'r', 0))
	if got := sentCommands(agent); !slices.Contains(got, "command-restart:cmd1") {
		t.Fatalf("r restarts it by its id: %v", got)
	}
	// The view follows the command to its new id: r again restarts the new one, never starts a
	// second copy beside it.
	if w, _ := windowOf[*watchApp](m); w.job != "cmd2" {
		t.Fatalf("after a restart the view still watches %q, want cmd2", w.job)
	}
	run(m, press(m, 'r', 0))
	if got := sentCommands(agent); !slices.Contains(got, "command-restart:cmd2") || strings.Count(strings.Join(got, " "), "command-restart:cmd1") != 1 {
		t.Fatalf("a second r restarted the old id again: %v", got)
	}
}

func TestTheViewSaysWhenTheCPUCannotBeRead(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 36})
	m.phase = busy
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "run_command", Arguments: map[string]any{"command": "make"}}))
	a := hung("c1")
	a.CPUKnown, a.Stuck = false, false
	setActivity(agent, a)
	lookAgain(m)
	m.enterTranscript()
	run(m, press(m, tea.KeyEnter, 0))
	if s := screen(m); !strings.Contains(s, "CPU unknown on this system") || strings.Contains(s, "looks stuck") {
		t.Fatalf("without a CPU reading it says so and calls nothing stuck:\n%s", screen(m))
	}
}

func TestAnEngineThatCannotSayWhatItsCommandsDoIsNamed(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 36})
	m.phase = busy
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "run_command", Arguments: map[string]any{"command": "make"}}))
	lookAgain(m)
	m.enterTranscript()
	run(m, press(m, tea.KeyEnter, 0))
	s := screen(m)
	if !strings.Contains(s, "$ make") || !strings.Contains(s, "This engine does not say what its commands are doing") {
		t.Fatalf("the view says what it cannot know:\n%s", s)
	}
}

func TestAHelperWithNoNewsForTheThresholdLooksStuck(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 36})
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"task": "audit the handlers", "agent": "explore"}})
	m.handleEvent(subagentEvent("d1", "explore", acp.RuntimeEvent{Type: "tool_call", ToolCallID: "r1", ToolName: "read_file", Arguments: map[string]any{"path": "h.go"}}))
	m.handleEvent(subagentEvent("d1", "explore", acp.RuntimeEvent{Type: "tool_result", ToolCallID: "r1", ToolName: "read_file", Content: "package h"}))
	card := m.tools["d1"]

	card.sub.lastEvent = time.Now().Add(-(helperStallAfter - time.Minute))
	lookAgain(m)
	if s := screen(m); strings.Contains(s, "looks stuck") {
		t.Fatalf("news a while ago, inside the threshold, is not stuck:\n%s", s)
	}
	card.sub.lastEvent = time.Now().Add(-(helperStallAfter + time.Minute))
	lookAgain(m)
	if s := screen(m); !strings.Contains(s, "looks stuck") {
		t.Fatalf("no news past the threshold looks stuck:\n%s", s)
	}
	m.selectItem(card)
	run(m, press(m, tea.KeyEnter, 0))
	s := screen(m)
	for _, want := range []string{"What's going on", "agent · explore", "no news for 6m00s", "read file h.go", "looks stuck", "x stop", "→ inspect"} {
		if !strings.Contains(s, want) {
			t.Errorf("the helper's view lacks %q:\n%s", want, s)
		}
	}
	run(m, press(m, 'x', 0))
	if got := sentCommands(agent); !slices.Contains(got, "agent-stop:d1") {
		t.Fatalf("x stops the helper: %v", got)
	}
	// Once it is done, it is never stuck.
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "d1", ToolName: "delegate_task", Content: "report"})
	if helperStuck(card, time.Now()) {
		t.Fatal("a finished helper is never stuck")
	}
}

// TestHelperStallInvariants: news resets it, it is never stuck before the threshold, and a
// finished helper is never stuck.
func TestHelperStallInvariants(t *testing.T) {
	now := time.Now()
	card := &toolItem{id: "d1", name: "delegate_task", started: now.Add(-time.Hour), sub: &subagentRun{}}
	for _, ago := range []time.Duration{0, time.Second, helperStallAfter / 2, helperStallAfter - time.Second} {
		card.sub.lastEvent = now.Add(-ago)
		if helperStuck(card, now) {
			t.Errorf("news %s ago: stuck before the threshold", ago)
		}
	}
	card.sub.lastEvent = now.Add(-helperStallAfter)
	if !helperStuck(card, now) {
		t.Error("no news for the threshold: stuck")
	}
	card.sub.apply(acp.RuntimeEvent{Type: "assistant_delta", Text: "still here"}, now)
	if helperStuck(card, now) {
		t.Error("news resets it")
	}
	fresh := &toolItem{id: "d2", name: "delegate_task", started: now}
	if helperStuck(fresh, now.Add(helperStallAfter-time.Second)) || !helperStuck(fresh, now.Add(helperStallAfter)) {
		t.Error("a helper with no news at all is judged from its start")
	}
	fresh.finish("done", false)
	if helperStuck(fresh, now.Add(time.Hour)) {
		t.Error("a finished helper is never stuck")
	}
}

func TestAStuckBackgroundCommandSaysSoInTheRailUntilItEnds(t *testing.T) {
	m := railModel(t, 140)
	agent := m.agent.(*fakeAgent)
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "b1", ToolName: "run_command", Arguments: map[string]any{"command": "./watch.sh", "background": true}}))
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "b1", ToolName: "run_command",
		Content: "Started cmd1 in the background (pid 42): ./watch.sh\ncmd1 running · 2s · 0 bytes\n[next: since=0]"}))
	stuck := acp.Activity{ID: "cmd1", Command: "./watch.sh", Pid: 42, Background: true, Status: "running", CPUKnown: true, Stuck: true, QuietMs: 400_000}
	setActivity(agent, stuck)
	lookAgain(m)
	if s := screen(m); !strings.Contains(s, "cmd1 looks stuck ./watch.sh") || !strings.Contains(s, "looks stuck · nothing printed") {
		t.Fatalf("the rail and the card say it looks stuck:\n%s", s)
	}
	stuck.Status, stuck.Stuck = "stopped", false
	setActivity(agent, stuck)
	lookAgain(m)
	if s := screen(m); strings.Contains(s, "looks stuck") || !strings.Contains(s, "cmd1 ./watch.sh · stopped") {
		t.Fatalf("an ended command is never stuck:\n%s", s)
	}
}
