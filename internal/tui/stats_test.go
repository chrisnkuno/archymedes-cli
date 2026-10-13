package tui

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

// someTurns records n finished turns, a minute apart, each a little longer and wordier than the last.
func someTurns(m *Model, n int) {
	start := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	for i := range n {
		at := start.Add(time.Duration(i) * time.Minute)
		m.stats.startTurn("task "+string(rune('a'+i)), at)
		m.stats.call(1000*(i+1), 100*(i+1), at.Add(time.Second))
		m.stats.call(500, 40, at.Add(2*time.Second))
		m.stats.tool("read_file")
		if i%2 == 0 {
			m.stats.tool("run_command")
		}
		m.stats.endTurn("end_turn", at.Add(time.Duration(3+i)*time.Second))
	}
}

func openStats(t *testing.T, m *Model) *statsApp {
	t.Helper()
	m.Update(fkey(9))
	s, ok := m.activeWindow().(*statsApp)
	if !ok {
		t.Fatalf("F9 opens Stats: %T", m.activeWindow())
	}
	return s
}

func TestStatsCollectsFromTheAgentsEvents(t *testing.T) {
	m, _ := newTestModel(t)
	typeText(m, "fix the bug")
	cmd := press(m, tea.KeyEnter, 0)
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "read_file"}}}})
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "model_turn", Usage: &acp.Usage{InputTokens: 1200, OutputTokens: 30}}}}})
	m.Update(agentMsg{acp.TextChunk{Text: "Fixed it."}})
	run(m, cmd)
	if len(m.stats.turns) != 1 {
		t.Fatalf("turns: %+v", m.stats.turns)
	}
	turn := m.stats.turns[0]
	if !turn.finished || turn.prompt != "fix the bug" || turn.in != 1200 || turn.out != 30 || turn.calls != 1 || turn.tools != 1 {
		t.Fatalf("turn: %+v", turn)
	}
	if m.stats.tools["read_file"] != 1 || len(m.stats.calls) != 1 {
		t.Fatalf("tools %v calls %v", m.stats.tools, m.stats.calls)
	}
}

func TestStreamRateBucketsTextAndShowsPauses(t *testing.T) {
	var s sessionStats
	s = newSessionStats()
	now := time.Now()
	s.text(10, now) // no turn: ignored
	s.startTurn("go", now)
	s.text(10, now.Add(100*time.Millisecond))
	s.text(5, now.Add(300*time.Millisecond))
	s.roll(now.Add(time.Second + 10*time.Millisecond))
	if want := []float64{10, 5, 0, 0}; len(s.stream) != len(want) || s.stream[0] != 10 || s.stream[1] != 5 || s.stream[3] != 0 {
		t.Fatalf("stream %v, want %v", s.stream, want)
	}
	s.roll(now.Add(time.Hour))
	if len(s.stream) != streamBuckets {
		t.Fatalf("kept %d buckets", len(s.stream))
	}
	s.endTurn("end_turn", now.Add(time.Hour))
	if s.stream != nil {
		t.Fatal("the rate outlived its turn")
	}
}

func TestStatsSaysWhatIsMissingBeforeThereIsData(t *testing.T) {
	m := projectModel(t)
	openStats(t, m)
	if !strings.Contains(screen(m), "No turns yet") {
		t.Fatalf("empty stats:\n%s", screen(m))
	}
	someTurns(m, 1)
	if s := screen(m); !strings.Contains(s, "needs two finished turns") || !strings.Contains(s, "Tokens per turn") {
		t.Fatalf("one turn:\n%s", s)
	}
}

func TestStatsDrawsTheSessionAndPicksATurn(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	someTurns(m, 4)
	s := openStats(t, m)
	out := screen(m)
	for _, want := range []string{"4 turns", "8 model calls", "Tokens per turn", "Seconds per turn", "Output per model call", "read file 4", "run command 2", "turn 4", "“task d”"} {
		if !strings.Contains(out, want) {
			t.Errorf("stats lack %q:\n%s", want, out)
		}
	}
	if !strings.ContainsAny(out, "⣀⡀⠄⠂⠁⢀⠠⠐⠈") {
		t.Errorf("no braille line:\n%s", out)
	}
	press(m, tea.KeyLeft, 0)
	press(m, tea.KeyLeft, 0)
	if !strings.Contains(screen(m), "turn 2 · 4.0s") {
		t.Fatalf("←← selects turn 2:\n%s", screen(m))
	}
	for range 9 {
		press(m, tea.KeyRight, 0)
	}
	if s.turn(4) != 3 {
		t.Fatalf("→ stops at the last turn: %d", s.turn(4))
	}

	// A click on the first bar's column picks turn 1.
	m.View()
	time.Sleep(20 * time.Millisecond)
	z := m.zones.frame.Get(s.bars.ZoneID())
	if z.IsZero() {
		t.Fatal("the token chart has no zone")
	}
	for x := z.StartX; x <= z.EndX && s.selected != 0; x++ {
		click(m, x, z.StartY)
	}
	if s.selected != 0 || !strings.Contains(screen(m), "turn 1 ·") {
		t.Fatalf("a click on the first bar did not pick turn 1: %d", s.selected)
	}
}

func TestStatsFitsEverySize(t *testing.T) {
	m := projectModel(t)
	someTurns(m, 30)
	openStats(t, m)
	for _, size := range [][2]int{{200, 60}, {160, 40}, {120, 32}, {90, 30}, {80, 24}, {50, 16}, {30, 8}, {14, 4}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		assertFits(t, m, "stats")
	}
}

func TestTheTrayShowsTheStreamingRate(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 30})
	typeText(m, "go")
	press(m, tea.KeyEnter, 0)
	m.stats.stream = []float64{0, 3, 9, 4}
	top := strings.Split(screen(m), "\n")[0]
	if !strings.ContainsAny(top, "▁▂▃▄▅▆▇█") {
		t.Fatalf("no rate sparkline in the tray: %q", top)
	}
}
