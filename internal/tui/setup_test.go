package tui

import (
	"context"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// firstRunProviders is what the agent offers on first run: a key-only provider, one with an optional
// base URL, and one that needs both a key and a URL.
func firstRunProviders() []acp.ProviderOverview {
	return []acp.ProviderOverview{
		{ID: "free", Label: "Free models (OpenRouter)", Missing: []string{"OPENROUTER_API_KEY"}, KeyVariable: "OPENROUTER_API_KEY", KeyURL: "https://openrouter.ai/keys", Model: "openrouter/free",
			Fields: []acp.ProviderField{{Key: "OPENROUTER_API_KEY", Label: "OpenRouter API key", Kind: "secret", Required: true}}},
		{ID: "anthropic", Label: "Anthropic", Missing: []string{"ANTHROPIC_API_KEY"}, KeyVariable: "ANTHROPIC_API_KEY", KeyURL: "https://console.anthropic.com/settings/keys", Model: "claude-sonnet-5",
			Fields: []acp.ProviderField{
				{Key: "ANTHROPIC_API_KEY", Label: "Anthropic API key", Kind: "secret", Required: true},
				{Key: "ANTHROPIC_BASE_URL", Label: "Anthropic base URL", Kind: "url", Placeholder: "https://api.anthropic.com"},
			}},
		{ID: "openai-compatible", Label: "OpenAI-compatible", Missing: []string{"OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"}, Model: "my-model",
			Fields: []acp.ProviderField{
				{Key: "OPENAI_COMPATIBLE_API_KEY", Label: "OpenAI-compatible API key", Kind: "secret", Required: true},
				{Key: "OPENAI_COMPATIBLE_BASE_URL", Label: "OpenAI-compatible base URL", Kind: "url", Required: true, Placeholder: "https://…/v1"},
			}},
	}
}

func unconfigured(t *testing.T) (*Model, *fakeAgent) {
	t.Helper()
	agent := &fakeAgent{messages: make(chan any, 16), providers: firstRunProviders()}
	m := New(Options{NoWallpaper: true, Start: func(context.Context) (Agent, error) { return agent, nil }, Cwd: "/tmp/project"})
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	_, cmd := m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Reason: "No model provider is configured"}})
	run(m, cmd)
	return m, agent
}

func TestFirstRunConnectsAProviderPicksAModelFetchedFromItAndOpensTheSession(t *testing.T) {
	m, agent := unconfigured(t)
	s := screen(m)
	for _, want := range []string{"Welcome to Archymedes", "Free models (OpenRouter)", "no paid account needed", "OpenAI-compatible"} {
		if !strings.Contains(s, want) {
			t.Fatalf("lacks %q:\n%s", want, s)
		}
	}
	press(m, tea.KeyDown, 0)
	press(m, tea.KeyEnter, 0)
	if s := screen(m); !strings.Contains(s, "Get a key") || !strings.Contains(s, "Anthropic base URL") {
		t.Fatalf("the form shows the key link and the optional base URL:\n%s", s)
	}
	typeText(m, "sk-ant-secret")
	if strings.Contains(screen(m), "sk-ant-secret") {
		t.Fatal("the key is shown on screen")
	}
	agent.connectResult = &acp.ConnectResult{Error: "Anthropic refused the key (provider returned 401).", Field: "ANTHROPIC_API_KEY"}
	run(m, press(m, tea.KeyEnter, 0)) // one enter connects: the base URL is optional
	if s := screen(m); !strings.Contains(s, "refused the key") || m.connectDialog() == nil || m.connectDialog().step != stepForm {
		t.Fatalf("a refused key stays on the form and says why:\n%s", s)
	}
	agent.connectResult = nil
	agent.providerModels = []string{"claude-haiku-5", "claude-sonnet-5"}
	run(m, press(m, tea.KeyEnter, 0))
	if s := screen(m); !strings.Contains(s, "claude-haiku-5") || !strings.Contains(s, "› claude-sonnet-5") {
		t.Fatalf("its models, fetched, the current one preselected:\n%s", s)
	}
	run(m, press(m, tea.KeyEnter, 0))
	if m.overlay != nil || m.phase != ready || m.session.ID != "s1" {
		t.Fatalf("overlay=%T phase=%v session=%q", m.overlay, m.phase, m.session.ID)
	}
	if got := agent.connected[len(agent.connected)-1]; got != "anthropic:ANTHROPIC_API_KEY=sk-ant-secret,ANTHROPIC_BASE_URL=" {
		t.Fatalf("connected %q", got)
	}
	if !contains(agent.set, "ARCHYMEDES_PROVIDER=anthropic") || !contains(agent.remembered, "anthropic/claude-sonnet-5") {
		t.Fatalf("set %v remembered %v", agent.set, agent.remembered)
	}
}

func TestABaseURLProviderIsAskedForEverythingItNeeds(t *testing.T) {
	m, agent := unconfigured(t)
	press(m, tea.KeyDown, 0)
	press(m, tea.KeyDown, 0)
	press(m, tea.KeyEnter, 0)
	typeText(m, "sk-local")
	press(m, tea.KeyEnter, 0) // the URL is required and empty: enter moves to it rather than connecting
	if len(agent.connected) != 0 || m.connectDialog().focus != 1 {
		t.Fatalf("connected %v focus %d", agent.connected, m.connectDialog().focus)
	}
	typeText(m, "http://localhost:8000/v1")
	agent.providerModels = []string{"qwen-coder"}
	run(m, press(m, tea.KeyEnter, 0))
	if got := agent.connected[0]; got != "openai-compatible:OPENAI_COMPATIBLE_API_KEY=sk-local,OPENAI_COMPATIBLE_BASE_URL=http://localhost:8000/v1" {
		t.Fatalf("connected %q", got)
	}
	if !strings.Contains(screen(m), "qwen-coder") {
		t.Fatal(screen(m))
	}
}

func TestFirstRunEscapeGoesBackThenQuits(t *testing.T) {
	m, _ := unconfigured(t)
	press(m, tea.KeyEnter, 0)
	if cmd := press(m, tea.KeyEscape, 0); cmd != nil || m.overlay == nil {
		t.Fatal("esc on the form goes back to the list")
	}
	if cmd := press(m, tea.KeyEscape, 0); cmd == nil {
		t.Fatal("esc on the list quits")
	}
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func TestResumeIsAskedOfTheAgentWhenTheSessionOpens(t *testing.T) {
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{NoWallpaper: true, Start: func(context.Context) (Agent, error) { return agent, nil }, Resume: "latest"})
	_, cmd := m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	run(m, cmd)
	if agent.resumed != "latest" || m.phase != ready {
		t.Fatalf("resumed=%q phase=%v", agent.resumed, m.phase)
	}
}

func TestStartupNoticesArriveAsToastsOnceTheSessionIsOpen(t *testing.T) {
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{NoWallpaper: true, Start: func(context.Context) (Agent, error) { return agent, nil }})
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	_, cmd := m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	run(m, cmd)
	if !strings.Contains(screen(m), "3.0.1 is available") {
		t.Fatalf("no update notice:\n%s", screen(m))
	}
}
