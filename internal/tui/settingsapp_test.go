package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

func settingsFixture() acp.SettingsList {
	return acp.SettingsList{File: "/cfg/settings.json", Rows: []acp.SettingRow{
		{Key: "ARCHYMEDES_THEME", Label: "Theme", Section: "Appearance", Kind: "choice", Value: "archymedes-blue", IsSet: true,
			Choices: []acp.SettingChoice{{Value: "archymedes-blue", Label: "Blue"}, {Value: "parchment", Label: "Parchment"}}},
		{Key: "OPENROUTER_API_KEY", Label: "OpenRouter API key", Section: "Providers", Kind: "secret", Value: "sk-…abc", IsSet: true},
		{Key: "OPENAI_MODEL", Label: "OpenAI model", Section: "Providers", Kind: "text"},
		{Key: "OPENAI_BASE_URL", Label: "OpenAI base URL", Section: "Providers", Kind: "text", Value: "https://x", IsSet: true, OverriddenByEnvironment: true},
	}}
}

func openSettingsApp(t *testing.T) (*Model, *fakeAgent, *settingsApp) {
	t.Helper()
	m, agent := unconfigured(t)
	m.overlay = nil
	m.phase = ready
	m.session.ID = "s1"
	agent.settings = settingsFixture()
	run(m, m.openSettings())
	s := m.settingsWindow()
	if s == nil || s.list == nil {
		t.Fatalf("settings did not load: %+v", s)
	}
	return m, agent, s
}

func TestSettingsShowSectionsValuesAndMaskedSecrets(t *testing.T) {
	m, _, _ := openSettingsApp(t)
	out := screen(m)
	for _, want := range []string{"Settings", "Appearance", "Providers", "Theme", "archymedes-blue", "OpenRouter API key", "sk-…abc", "not set", "environment overrides"} {
		if !strings.Contains(out, want) {
			t.Errorf("settings lack %q:\n%s", want, out)
		}
	}
}

func TestPickingAChoiceSavesItAndAppliesTheTheme(t *testing.T) {
	m, agent, _ := openSettingsApp(t)
	press(m, tea.KeyEnter, 0) // edit Theme
	press(m, tea.KeyDown, 0)
	run(m, press(m, tea.KeyEnter, 0))
	if len(agent.set) == 0 || agent.set[len(agent.set)-1] != "ARCHYMEDES_THEME=parchment" {
		t.Fatalf("saved %v", agent.set)
	}
	if m.th.Name != "parchment" {
		t.Fatalf("theme is %q", m.th.Name)
	}
}

func TestAPastedKeyIsCleanedAndSavedAndAValidationErrorStaysInTheEditor(t *testing.T) {
	m, agent, s := openSettingsApp(t)
	press(m, tea.KeyDown, 0) // OpenRouter key
	press(m, tea.KeyEnter, 0)
	m.Update(tea.PasteMsg{Content: "export OPENROUTER_API_KEY=\"sk-or-new\"\n"})
	if strings.Contains(screen(m), "sk-or-new") {
		t.Fatal("a secret must not be echoed")
	}
	agent.setError = "That key looks wrong."
	run(m, press(m, tea.KeyEnter, 0))
	if !s.editing || !strings.Contains(screen(m), "That key looks wrong.") {
		t.Fatalf("a rejected value keeps the editor open with the reason:\n%s", screen(m))
	}
	agent.setError = ""
	run(m, press(m, tea.KeyEnter, 0))
	if got := agent.set[len(agent.set)-1]; got != "OPENROUTER_API_KEY=sk-or-new" {
		t.Fatalf("saved %v", agent.set)
	}
	if s.editing {
		t.Fatal("a saved value closes the editor")
	}
}

func TestClearingAndFiltering(t *testing.T) {
	m, agent, s := openSettingsApp(t)
	press(m, '/', 0)
	typeText(m, "base")
	press(m, tea.KeyEnter, 0)
	if v := s.visible(); len(v) != 1 || s.list.Rows[v[0]].Key != "OPENAI_BASE_URL" {
		t.Fatalf("filter shows %v", v)
	}
	press(m, '/', 0)
	typeText(m, "é")
	press(m, tea.KeyBackspace, 0)
	if s.filter != "base" {
		t.Fatalf("backspace should remove one character: %q", s.filter)
	}
	press(m, tea.KeyEnter, 0)
	run(m, press(m, 'd', 0))
	if len(agent.set) != 0 || !strings.Contains(screen(m), "press d again to clear OPENAI_BASE_URL") {
		t.Fatalf("one d must only ask: %v", agent.set)
	}
	press(m, tea.KeyDown, 0) // any other key keeps it
	press(m, tea.KeyUp, 0)
	run(m, press(m, 'd', 0))
	if len(agent.set) != 0 {
		t.Fatal("a d after another key asks again rather than clearing")
	}
	run(m, press(m, 'd', 0))
	if got := agent.set[len(agent.set)-1]; got != "OPENAI_BASE_URL=" {
		t.Fatalf("d clears: %v", agent.set)
	}
	if s.list.Rows[3].IsSet {
		t.Fatal("the row should now read as not set")
	}
}

func TestSettingsReplaceTheHandOffToTheTerminalMenu(t *testing.T) {
	m, _ := unconfigured(t)
	m.overlay = nil
	cmd, ok := m.runCommand("/settings")
	if !ok {
		t.Fatal("no /settings")
	}
	_ = cmd
	if m.settingsWindow() == nil {
		t.Fatal("/settings should open the in-app window")
	}
}
