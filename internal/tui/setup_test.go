package tui

import (
	"context"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

func unconfigured(t *testing.T) (*Model, *fakeAgent) {
	t.Helper()
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{Start: func(context.Context) (Agent, error) { return agent, nil }, Cwd: "/tmp/project"})
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Reason: "No model provider is configured", Providers: []acp.SetupProvider{
		{ID: "free", Label: "Free models (OpenRouter)", KeyVariable: "OPENROUTER_API_KEY", KeyURL: "https://openrouter.ai/keys"},
		{ID: "anthropic", Label: "Anthropic", KeyVariable: "ANTHROPIC_API_KEY"},
		{ID: "openai-compatible", Label: "OpenAI-compatible"}, // needs more than a key: not offered
	}}})
	return m, agent
}

func TestFirstRunAsksForAProviderAndAKeyThenOpensTheSession(t *testing.T) {
	m, agent := unconfigured(t)
	s := screen(m)
	if !strings.Contains(s, "Set up a model") || !strings.Contains(s, "Free models (OpenRouter)") || strings.Contains(s, "OpenAI-compatible") {
		t.Fatalf("setup screen:\n%s", s)
	}
	press(m, tea.KeyDown, 0)
	press(m, tea.KeyEnter, 0)
	typeText(m, "sk-ant-secret")
	if strings.Contains(screen(m), "sk-ant-secret") {
		t.Fatal("the key is shown on screen")
	}
	agent.saveResult = acp.SetupResult{OK: false, Error: "That key was rejected."}
	run(m, press(m, tea.KeyEnter, 0))
	if !strings.Contains(screen(m), "That key was rejected.") || m.overlay == nil {
		t.Fatalf("a rejected key stays on the key step and says why:\n%s", screen(m))
	}
	agent.saveResult = acp.SetupResult{OK: true, File: "/cfg/settings.json"}
	run(m, press(m, tea.KeyEnter, 0))
	if m.overlay != nil || m.phase != ready || m.session.ID != "s1" {
		t.Fatalf("overlay=%v phase=%v", m.overlay, m.phase)
	}
	if strings.Join(agent.saved, ",") != "anthropic=sk-ant-secret,anthropic=sk-ant-secret" {
		t.Fatalf("saved %q", agent.saved)
	}
	if !strings.Contains(screen(m), "Key saved to /cfg/settings.json") {
		t.Fatal(screen(m))
	}
}

func TestFirstRunEscapeGoesBackThenQuits(t *testing.T) {
	m, _ := unconfigured(t)
	press(m, tea.KeyEnter, 0)
	if cmd := press(m, tea.KeyEscape, 0); cmd != nil || m.overlay == nil {
		t.Fatal("esc on the key step goes back to the list")
	}
	if cmd := press(m, tea.KeyEscape, 0); cmd == nil {
		t.Fatal("esc on the list quits")
	}
}

func TestResumeIsAskedOfTheAgentWhenTheSessionOpens(t *testing.T) {
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{Start: func(context.Context) (Agent, error) { return agent, nil }, Resume: "latest"})
	_, cmd := m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	run(m, cmd)
	if agent.resumed != "latest" || m.phase != ready {
		t.Fatalf("resumed=%q phase=%v", agent.resumed, m.phase)
	}
}

func TestStartupNoticesArriveAsToastsOnceTheSessionIsOpen(t *testing.T) {
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{Start: func(context.Context) (Agent, error) { return agent, nil }})
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	_, cmd := m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	run(m, cmd)
	if !strings.Contains(screen(m), "3.0.1 is available") {
		t.Fatalf("no update notice:\n%s", screen(m))
	}
}
