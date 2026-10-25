package tui

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/config"
)

// onboardModel is a first run: a fresh config directory, the agent not yet started.
func onboardModel(t *testing.T) (*Model, *fakeAgent, string) {
	t.Helper()
	t.Setenv("DO_NOT_TRACK", "")
	dir := t.TempDir()
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{NoWallpaper: true, Start: func(context.Context) (Agent, error) { return agent, nil }, ConfigDir: dir})
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	return m, agent, dir
}

func walkthrough(t *testing.T, m *Model) *onboarding {
	t.Helper()
	ob, ok := m.overlay.(*onboarding)
	if !ok {
		t.Fatalf("no walkthrough open: %T", m.overlay)
	}
	return ob
}

func TestAFirstRunWalksSixStepsAndAppliesWhatWasChosen(t *testing.T) {
	m, agent, dir := onboardModel(t)
	ob := walkthrough(t, m)
	if s := screen(m); !strings.Contains(s, "Welcome to Friday") || !strings.Contains(s, "What should Friday call you?") || !strings.Contains(s, "step 1 of 6") {
		t.Fatalf("hello step:\n%s", s)
	}
	run(m, m.onboardFocus())
	typeText(m, "Ada")
	m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	m.Update(connectedMsg{session: acp.Session{ID: "s1", Info: acp.SessionInfo{Model: "kimi-k2", ProviderLabel: "OpenRouter"}}})

	// Look: → previews the next theme.
	press(m, tea.KeyEnter, 0)
	if ob.step != obLook || !strings.Contains(screen(m), "Welcome, Ada") {
		t.Fatalf("enter did not reach Look (step %d):\n%s", ob.step, screen(m))
	}
	before := m.th.Name
	press(m, tea.KeyRight, 0)
	if m.th.Name == before {
		t.Fatal("moving over the theme tiles did not preview")
	}
	chosen := m.th.Name

	// Mode: build → auto.
	press(m, tea.KeyEnter, 0)
	press(m, tea.KeyRight, 0)

	// Keys: pressing the mode key ticks its tile and does not change the mode.
	press(m, tea.KeyEnter, 0)
	press(m, tea.KeyTab, tea.ModShift)
	if !ob.lessons[1].tried || !strings.Contains(screen(m), "✓ shift+tab") {
		t.Fatalf("the mode key was not ticked:\n%s", screen(m))
	}
	if m.mode != "build" {
		t.Fatal("trying a key ran it")
	}

	// Connect: what is ready, and the count turned off.
	press(m, tea.KeyEnter, 0)
	if s := screen(m); !strings.Contains(s, "Ready") || !strings.Contains(s, "kimi-k2") || !strings.Contains(s, "Count installs") {
		t.Fatalf("connect step:\n%s", s)
	}
	press(m, tea.KeyRight, 0)

	// Back and forward again keeps the choices.
	press(m, tea.KeyBackspace, 0)
	if ob.step != obKeys {
		t.Fatalf("backspace went to %d", ob.step)
	}
	press(m, tea.KeyEnter, 0)

	// Start: enter puts the first request in the input and ends the walkthrough.
	press(m, tea.KeyEnter, 0)
	cmd := press(m, tea.KeyEnter, 0)
	if m.overlay != nil {
		t.Fatalf("the walkthrough stayed open: %T", m.overlay)
	}
	run(m, cmd)
	if got := m.input.value(); got != m.starters()[0] {
		t.Fatalf("input holds %q", got)
	}
	state := config.LoadState(dir)
	if !state.Onboarded || state.Name != "Ada" {
		t.Fatalf("not remembered: %+v", state)
	}
	if !slices.Contains(agent.set, "ARCHYMEDES_THEME="+chosen) || !slices.Contains(agent.set, "ARCHYMEDES_TELEMETRY=off") {
		t.Fatalf("settings saved: %v", agent.set)
	}
	if !slices.Contains(agent.modes, "auto") {
		t.Fatalf("mode not set: %v", agent.modes)
	}
	if !strings.Contains(screen(m), "Ada.") {
		t.Fatalf("the greeting does not use the name:\n%s", screen(m))
	}
}

func TestAMissingProviderWaitsForTheWalkthroughThenConnects(t *testing.T) {
	m, agent, _ := onboardModel(t)
	m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: false, Reason: "no key"}})
	ob := walkthrough(t, m)
	for ob.step != obConnect {
		press(m, tea.KeyEnter, 0)
	}
	if s := screen(m); !strings.Contains(s, "No provider is set up yet") {
		t.Fatalf("connect step without a provider:\n%s", s)
	}
	press(m, tea.KeyEscape, 0)
	if _, ok := m.overlay.(*connectDialog); !ok {
		t.Fatalf("the connect dialog did not follow: %T", m.overlay)
	}
}

func TestEscSkipsTheWalkthroughAndAStrayClickDoesNot(t *testing.T) {
	m, agent, dir := onboardModel(t)
	m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	m.Update(connectedMsg{session: acp.Session{ID: "s1"}})
	click(m, 0, 0)
	walkthrough(t, m)
	press(m, tea.KeyEscape, 0)
	if m.overlay != nil || !config.LoadState(dir).Onboarded {
		t.Fatalf("esc did not end it: %T", m.overlay)
	}
	// alt+w brings it back; once seen, it never opens unasked.
	press(m, 'w', tea.ModAlt)
	walkthrough(t, m)
	again := New(Options{ConfigDir: dir})
	if _, ok := again.overlay.(*onboarding); ok {
		t.Fatal("the walkthrough opened twice")
	}
}

func TestSomeoneWhoUsedFridayBeforeTheWalkthroughSeesItOnce(t *testing.T) {
	dir := t.TempDir()
	config.SaveState(dir, config.State{Welcomed: true})
	m := New(Options{NoWallpaper: true, ConfigDir: dir})
	if _, ok := m.overlay.(*onboarding); !ok {
		t.Fatalf("an upgrade did not get the walkthrough: %T", m.overlay)
	}
	if one := New(Options{NoWallpaper: true, ConfigDir: dir, Prompt: "fix it"}); one.overlay != nil {
		t.Fatal("a one-shot prompt got the walkthrough")
	}
}

func TestTheWalkthroughIsInTheKeysAndTheStartMenu(t *testing.T) {
	m, _, _ := onboardModel(t)
	if !strings.Contains(fmt.Sprint(m.keys.fullHelp()), "walkthrough") {
		t.Fatal("help does not list the walkthrough key")
	}
	for _, e := range newStartMenu(m).entries {
		if e.label == "/welcome" && strings.HasPrefix(e.hint, "alt+w") {
			return
		}
	}
	t.Fatal("the start menu's /welcome does not show alt+w")
}

func TestTheGreetingNamesThePerson(t *testing.T) {
	morning := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)
	if got := greeting(morning, "Ada"); got != "Good morning, Ada." {
		t.Fatal(got)
	}
	if got := greeting(morning, ""); got != "Good morning." {
		t.Fatal(got)
	}
}
