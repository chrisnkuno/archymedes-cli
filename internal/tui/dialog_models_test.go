package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestModelPickerFiltersAndSwitchesKeepingTheConversation(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m.notice(noticeInfo, "earlier conversation")
	typeText(m, "/model")
	run(m, press(m, tea.KeyEnter, 0))
	if _, ok := m.overlay.(*modelPicker); !ok {
		t.Fatal("/model opens the picker")
	}
	s := screen(m)
	for _, want := range []string{"claude-opus-5", "Anthropic", "USD 15.00/USD 75.00 per Mtok", "★"} {
		if !strings.Contains(s, want) {
			t.Fatalf("picker lacks %q:\n%s", want, s)
		}
	}
	typeText(m, "opus")
	run(m, press(m, tea.KeyEnter, 0))
	if m.overlay != nil || m.session.Info.Model != "claude-opus-5" || strings.Join(agent.models, ",") != "anthropic/claude-opus-5" {
		t.Fatalf("overlay=%v model=%q switched=%v", m.overlay, m.session.Info.Model, agent.models)
	}
	if s := screen(m); !strings.Contains(s, "earlier conversation") || !strings.Contains(s, "claude-opus-5") {
		t.Fatalf("conversation or header lost:\n%s", s)
	}
}

func TestModelCommandSwitchesStraightToAnUnambiguousName(t *testing.T) {
	m, agent := newTestModel(t)
	typeText(m, "/model gpt")
	run(m, press(m, tea.KeyEnter, 0))
	if m.overlay != nil || len(agent.models) != 1 || agent.models[0] != "openai/gpt-5.6-terra" {
		t.Fatalf("overlay=%v switched=%v", m.overlay, agent.models)
	}
	// Ambiguous: two Anthropic models match, so the picker opens on the query instead of guessing.
	typeText(m, "/model claude")
	run(m, press(m, tea.KeyEnter, 0))
	p, ok := m.overlay.(*modelPicker)
	if !ok || len(p.shown) != 2 || len(agent.models) != 1 {
		t.Fatalf("overlay=%T switched=%v", m.overlay, agent.models)
	}
}

func TestModelPickerFitsEverySize(t *testing.T) {
	m, _ := newTestModel(t)
	typeText(m, "/model")
	run(m, press(m, tea.KeyEnter, 0))
	for _, size := range [][2]int{{100, 30}, {50, 16}, {20, 6}, {12, 3}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		assertFits(t, m, "model picker")
	}
}

func TestFreeModelFitLabelsAndWarnings(t *testing.T) {
	slow := acp.ModelChoice{Model: "nvidia/nemotron-3.5-lightning:free", Fit: "slow", FitNote: "15s-3min before the first token"}
	gated := acp.ModelChoice{Model: "thinkingmachines/inkling:free", Fit: "apps-only", FitNote: "refused (403) here"}
	small := acp.ModelChoice{Model: "liquid/lfm-2.5-2.6b:free", Small: true, Fit: "small"}
	busy := acp.ModelChoice{Model: "google/gemma-4-31b-it:free", Fit: "busy"}
	agent := acp.ModelChoice{Model: "cohere/north-mini-code:free", Fit: "agent"}
	for choice, label := range map[*acp.ModelChoice]string{&slow: "slow", &gated: "apps only", &small: "small", &busy: "busy", &agent: ""} {
		if got := fitLabel(*choice); got != label {
			t.Errorf("fitLabel(%s) = %q, want %q", choice.Model, got, label)
		}
	}
	for choice, label := range map[*acp.ModelChoice]string{&slow: "slow", &gated: "apps only", &small: "", &busy: "", &agent: ""} {
		if got := rowLabel(*choice); got != label {
			t.Errorf("rowLabel(%s) = %q, want %q", choice.Model, got, label)
		}
	}
	if w := fitWarning(slow); !strings.Contains(w, "3min") || !strings.Contains(w, "openrouter/free") {
		t.Errorf("slow warning should say why and what to use instead: %q", w)
	}
	if w := fitWarning(gated); !strings.Contains(w, "403") {
		t.Errorf("an apps-only model should say why it will be refused: %q", w)
	}
	if fitWarning(agent) != "" {
		t.Error("a verified model should be switched to without a warning")
	}
}
