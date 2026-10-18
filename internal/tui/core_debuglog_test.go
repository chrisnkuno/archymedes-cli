package tui

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestDebugLogRecordsWhatHappensButNotTheTicks(t *testing.T) {
	m, _ := newTestModel(t)
	var buf bytes.Buffer
	m.opts.Debug = NewDebugLog(&buf)
	typeText(m, "hi")
	m.Update(spinner.TickMsg{})
	m.Update(agentMsg{acp.TurnEnded{StopReason: "end_turn"}})
	out := buf.String()
	for _, want := range []string{`msg=key key=h`, `msg="turn ended" stop=end_turn`} {
		if !strings.Contains(out, want) {
			t.Fatalf("log lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "TickMsg") {
		t.Fatal("animation ticks logged")
	}
	if NewDebugLog(nil) != nil {
		t.Fatal("no writer, no logger")
	}
}

func TestARetryShowsItsWaitDraining(t *testing.T) {
	m, _ := newTestModel(t)
	typeText(m, "go")
	press(m, tea.KeyEnter, 0)
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "provider_retry", NextAttempt: 2, MaxAttempts: 5, DelayMs: 8000, Reason: "rate_limited"}}}})
	s := screen(m)
	if !strings.Contains(s, "retry 2/5: rate_limited") || !strings.Contains(s, "━") || !strings.Contains(s, "8s") {
		t.Fatalf("retry line:\n%s", s)
	}
	m.retryStart = time.Now().Add(-6 * time.Second)
	if s := screen(m); !strings.Contains(s, " 2s") || strings.Count(s, "━") >= 16 {
		t.Fatalf("bar did not drain:\n%s", s)
	}
}

func TestAShortenedConversationIsSaidOutLoud(t *testing.T) {
	// The agent shortened the transcript to fit the model: the person should know what was set aside.
	m, _ := newTestModel(t)
	typeText(m, "go")
	press(m, tea.KeyEnter, 0)
	for step, want := range map[int]string{1: "old tool output shortened", 2: "the earlier conversation set aside"} {
		m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "context_shrunk", Step: step}}}})
		if s := screen(m); !strings.Contains(s, want) {
			t.Fatalf("step %d: no %q:\n%s", step, want, s)
		}
	}
}
