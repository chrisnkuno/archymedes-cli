package tui

import (
	"context"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// codexRow is Codex as the agent lists it while the person is signed out of Codex.
func codexRow() acp.ProviderOverview {
	return acp.ProviderOverview{
		ID: "codex", Label: "Codex (your ChatGPT plan)", Missing: []string{"signing in to Codex (codex login)"}, Model: "default",
		Login: []string{"/usr/local/bin/codex", "login"},
		About: "Runs your own Codex on your ChatGPT plan. Signing in is Codex's own; Archymedes never sees your account.",
	}
}

func TestCodexSignsInWithItsOwnLoginAndSaysItIsCodex(t *testing.T) {
	agent := &fakeAgent{messages: make(chan any, 16), providers: append([]acp.ProviderOverview{codexRow()}, firstRunProviders()...)}
	m := New(Options{NoWallpaper: true, Start: func(context.Context) (Agent, error) { return agent, nil }, Cwd: "/tmp/project"})
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	_, cmd := m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Reason: "No model provider is configured"}})
	run(m, cmd)
	if s := screen(m); !strings.Contains(s, "Codex (your ChatGPT plan)") || !strings.Contains(s, "sign in with ChatGPT") {
		t.Fatalf("Codex is offered with what it needs:\n%s", s)
	}
	press(m, tea.KeyEnter, 0)
	s := screen(m)
	for _, want := range []string{"Runs your own Codex on your ChatGPT plan", "enter signs in", "Codex's sign-in opens"} {
		if !strings.Contains(s, want) {
			t.Fatalf("the Codex form lacks %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "Claude") {
		t.Fatalf("the Codex form speaks of Claude:\n%s", s)
	}
	if cmd := press(m, tea.KeyEnter, 0); cmd == nil || !strings.Contains(screen(m), "signing in, in Codex") {
		t.Fatalf("enter starts Codex's own sign-in:\n%s", screen(m))
	}
}

func TestProvidersNamesCodexsInstallAndSignIn(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 36})
	row := codexRow()
	row.Login, row.KeyURL, row.Missing = nil, "https://developers.openai.com/codex/cli", []string{"Codex installed"}
	agent.providers = []acp.ProviderOverview{row}
	deliver(m, m.runAction("providers"))
	if s := screen(m); !strings.Contains(s, "Install Codex: ") || strings.Contains(s, "Install Claude Code") {
		t.Fatalf("the install link names Codex:\n%s", s)
	}
}
