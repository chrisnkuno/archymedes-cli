package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestTheTestFirstStepperMarksDoneNextAndPending(t *testing.T) {
	m, _ := newTestModel(t)
	cases := []struct {
		state acp.TestFirstState
		want  string
	}{
		{acp.TestFirstState{Tests: []string{"a_test.go"}}, "test first  ✓ 1 test  ● red  ○ code  ○ green  ○ checks"},
		{acp.TestFirstState{Tests: []string{"a_test.go", "b_test.go"}, Red: true, Code: []string{"a.go"}}, "test first  ✓ 2 tests  ✓ red  ✓ code  ● green  ○ checks"},
		// Code before any failing test: red is passed over, not pending.
		{acp.TestFirstState{Code: []string{"a.go"}}, "test first  ● tests  – red  ✓ code  ○ green  ○ checks"},
		{acp.TestFirstState{Tests: []string{"a_test.go"}, Red: true, Code: []string{"a.go"}, Green: true, Checked: true}, "test first  ✓ 1 test  ✓ red  ✓ code  ✓ green  ✓ checks"},
	}
	for _, c := range cases {
		if got := ansi.Strip(testFirstStepper(m.th, c.state)); got != c.want {
			t.Errorf("stepper\n got %q\nwant %q", got, c.want)
		}
	}
}

func TestTheTurnSaysHowItsTestFirstRunEnded(t *testing.T) {
	cases := map[string]acp.TestFirstState{
		"1 test file · red → green · checked": {Tests: []string{"a_test.go"}, Red: true, Code: []string{"a.go"}, Green: true, Checked: true},
		"no tests · not green · unchecked":    {Code: []string{"a.go"}},
		"2 test files · green · unchecked":    {Tests: []string{"a", "b"}, Code: []string{"a.go"}, Green: true},
	}
	for want, state := range cases {
		if got := testFirstSummary(state); got != want {
			t.Errorf("summary %q, want %q", got, want)
		}
	}
}

func TestTheStepperIsLiveDuringTheTurnAndSummedUpAfter(t *testing.T) {
	m, _ := newTestModel(t)
	m.phase = busy
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "write_file", Arguments: map[string]any{"path": "sum_test.go"}})
	m.handleRuntime(acp.RuntimeEvent{Type: "test_first", State: &acp.TestFirstState{Tests: []string{"sum_test.go"}}})
	if s := screen(m); !strings.Contains(s, "✓ 1 test  ● red") {
		t.Fatalf("live stepper missing:\n%s", s)
	}
	m.handleRuntime(acp.RuntimeEvent{Type: "test_first", State: &acp.TestFirstState{Tests: []string{"sum_test.go"}, Red: true, Code: []string{"sum.go"}, Green: true, Checked: true}})
	m.tr.add(&turnItem{stopReason: "end_turn", testFirst: m.testFirst})
	m.phase = ready
	s := screen(m)
	if strings.Contains(s, "test first  ✓") {
		t.Errorf("the live line goes with the turn:\n%s", s)
	}
	if !strings.Contains(s, "red → green · checked") {
		t.Errorf("the turn's closing rule sums it up:\n%s", s)
	}
}
