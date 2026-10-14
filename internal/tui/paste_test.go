package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

func TestCleanKey(t *testing.T) {
	for in, want := range map[string]string{
		"sk-or-abc":                             "sk-or-abc",
		"  sk-or-abc \n":                        "sk-or-abc",
		"\n\nOPENROUTER_API_KEY=sk-or-abc\n":    "sk-or-abc",
		"export OPENROUTER_API_KEY=\"sk-or-1\"": "sk-or-1",
		"'sk-1'":                                "sk-1",
		"":                                      "",
		"  \n ":                                 "",
		"dGVzdA==":                              "dGVzdA==",
		"abc123=def":                            "abc123=def",
		"OPENAI_API_KEY = sk-proj-1\r\n":        "sk-proj-1",
	} {
		if got := cleanKey(in); got != want {
			t.Errorf("cleanKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPastedKeyReachesTheSetupDialogCleaned(t *testing.T) {
	m, agent := unconfigured(t)
	// Pasting before choosing a provider goes straight to the highlighted provider's key field.
	m.Update(tea.PasteMsg{Content: "export OPENROUTER_API_KEY=\"sk-or-pasted\"\n"})
	s, ok := m.overlay.(*setupOverlay)
	if !ok || !s.entering || s.input.Value() != "sk-or-pasted" {
		t.Fatalf("overlay=%#v", m.overlay)
	}
	if m.input.value() != "" {
		t.Fatalf("the paste leaked into the composer: %q", m.input.value())
	}
	agent.saveResult = acp.SetupResult{OK: true, File: "/cfg/settings.json"}
	run(m, press(m, tea.KeyEnter, 0))
	if len(agent.saved) == 0 || agent.saved[0] != "free=sk-or-pasted" {
		t.Fatalf("saved %q", agent.saved)
	}
}

func TestCopyTakesTheLastReplyAndCodeBlock(t *testing.T) {
	m, _ := unconfigured(t)
	m.overlay = nil
	a := &assistantItem{}
	a.append("Here:\n```go\nfmt.Println(1)\n```\nand more\n```sh\nls\n```")
	m.tr.items = append(m.tr.items, a)
	if got := m.lastCodeBlock(); got != "ls" {
		t.Fatalf("code block %q", got)
	}
	if !strings.HasPrefix(m.lastReply(), "Here:") {
		t.Fatal(m.lastReply())
	}
	m.cmdSelect("")
	if !m.selecting {
		t.Fatal("/select should hand the mouse to the terminal")
	}
}

func TestAPasteLandsInTheOpenDialogsSearchBoxOnOneLine(t *testing.T) {
	m, _ := newTestModel(t)
	m.runAction("start")
	m.Update(tea.PasteMsg{Content: "  key\nbindings "})
	menu, ok := m.overlay.(*startMenu)
	if !ok {
		t.Fatalf("overlay %T", m.overlay)
	}
	if got := menu.filter.Value(); got != "key bindings" {
		t.Fatalf("filter %q", got)
	}
	if m.input.value() != "" {
		t.Fatal("the paste leaked into the composer")
	}
}
