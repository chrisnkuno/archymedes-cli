package tui

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// claudeRow is Claude as the agent lists it while the person is signed out of Claude Code.
func claudeRow() acp.ProviderOverview {
	return acp.ProviderOverview{
		ID: "claude", Label: "Claude (your subscription)", Missing: []string{"signing in to Claude (claude auth login)"}, Model: "default",
		Login: []string{"/usr/local/bin/claude", "auth", "login"},
	}
}

func claudeFirstRun(t *testing.T) (*Model, *fakeAgent) {
	t.Helper()
	agent := &fakeAgent{messages: make(chan any, 16), providers: append([]acp.ProviderOverview{claudeRow()}, firstRunProviders()...)}
	m := New(Options{NoWallpaper: true, Start: func(context.Context) (Agent, error) { return agent, nil }, Cwd: "/tmp/project"})
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	_, cmd := m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Reason: "No model provider is configured"}})
	run(m, cmd)
	return m, agent
}

func TestClaudeSignsInWithClaudeCodeThenConnectsAndOpensTheSessionOnIt(t *testing.T) {
	m, agent := claudeFirstRun(t)
	if s := screen(m); !strings.Contains(s, "Claude (your subscription)") || !strings.Contains(s, "sign in with Claude") {
		t.Fatalf("Claude is offered with what it needs:\n%s", s)
	}
	press(m, tea.KeyEnter, 0)
	s := screen(m)
	for _, want := range []string{"Runs your own Claude Code on your Claude plan", "never sees your account", "enter signs in"} {
		if !strings.Contains(s, want) {
			t.Fatalf("the Claude form lacks %q:\n%s", want, s)
		}
	}
	// enter hands the terminal to `claude auth login`; nothing is typed into Archymedes.
	if cmd := press(m, tea.KeyEnter, 0); cmd == nil {
		t.Fatal("enter did not start Claude Code's sign-in")
	}
	if d := m.connectDialog(); d == nil || d.step != stepWorking || !strings.Contains(screen(m), "signing in, in Claude Code") {
		t.Fatalf("waits while Claude Code signs in:\n%s", screen(m))
	}

	// Back from the sign-in: connecting checks it (and installs the SDK), and Claude's models follow.
	agent.providerModels = []string{"default", "opus", "sonnet", "haiku"}
	agent.connectResult = &acp.ConnectResult{OK: true, Models: agent.providerModels, Note: "Signed in with Claude Max: turns use your plan's limits."}
	_, cmd := m.Update(signedInMsg{})
	run(m, cmd)
	if got := agent.connected[len(agent.connected)-1]; got != "claude:" {
		t.Fatalf("connected %q: Claude is connected with nothing filled in", got)
	}
	if s := screen(m); !strings.Contains(s, "› default") || !strings.Contains(s, "opus") || !strings.Contains(s, "Signed in with Claude Max") {
		t.Fatalf("Claude's models, and which plan it is signed in with:\n%s", s)
	}
	press(m, tea.KeyDown, 0)
	run(m, press(m, tea.KeyEnter, 0))
	if !contains(agent.set, "ARCHYMEDES_PROVIDER=claude") || !contains(agent.remembered, "claude/opus") || m.session.ID != "s1" {
		t.Fatalf("set %v remembered %v session %q", agent.set, agent.remembered, m.session.ID)
	}
}

func TestASignInThatDidNotFinishSaysSoAndStaysOnTheForm(t *testing.T) {
	m, agent := claudeFirstRun(t)
	press(m, tea.KeyEnter, 0)
	press(m, tea.KeyEnter, 0)
	_, cmd := m.Update(signedInMsg{err: errors.New("exit status 1")})
	run(m, cmd)
	d := m.connectDialog()
	if d == nil || d.step != stepForm || !strings.Contains(screen(m), "Sign-in did not finish: exit status 1") {
		t.Fatalf("a failed sign-in stays on the form:\n%s", screen(m))
	}
	if len(agent.connected) != 0 {
		t.Fatalf("connected anyway: %v", agent.connected)
	}
}

func TestProvidersSaysHowClaudeIsSetUp(t *testing.T) {
	m, agent := readyModel(t)
	ready := claudeRow()
	ready.Login, ready.Missing, ready.Configured, ready.Note = nil, nil, true, "Signed in with Claude Pro: turns use your plan's limits."
	missing := acp.ProviderOverview{ID: "claude", Label: "Claude (your subscription)", Missing: []string{"Claude Code installed (https://code.claude.com/docs/en/setup)"}, KeyURL: "https://code.claude.com/docs/en/setup", Model: "default"}
	agent.providers = []acp.ProviderOverview{ready}
	run(m, m.openProviders())
	if s := screen(m); !strings.Contains(s, "Signed in with Claude Pro") || !strings.Contains(s, "ready") {
		t.Fatalf("the ready row says which plan:\n%s", s)
	}
	agent.providers = []acp.ProviderOverview{missing}
	run(m, m.loadProviders())
	if s := screen(m); !strings.Contains(s, "Install Claude Code: https://code.claude.com/docs/en/setup") {
		t.Fatalf("a missing Claude Code says where to get it:\n%s", s)
	}
	agent.providers = []acp.ProviderOverview{claudeRow()}
	run(m, m.loadProviders())
	if s := screen(m); !strings.Contains(s, "enter opens Claude Code's own sign-in") {
		t.Fatalf("a signed-out Claude says enter signs in:\n%s", s)
	}
}

func TestClaudeCodesOwnCompactionIsSaidInTokens(t *testing.T) {
	m, _ := readyModel(t)
	m.handleEvent(acp.Event{Type: "compaction", TokensBefore: 152_300})
	if s := screen(m); !strings.Contains(s, "Compacted the conversation (it was 152.3k tokens).") {
		t.Fatalf("compaction notice:\n%s", s)
	}
}
