package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
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
	// Pasting on the provider list opens the highlighted provider's form with the key in it.
	m.Update(tea.PasteMsg{Content: "export OPENROUTER_API_KEY=\"sk-or-pasted\"\n"})
	d := m.connectDialog()
	if d == nil || d.step != stepForm || d.inputs[0].Value() != "sk-or-pasted" {
		t.Fatalf("dialog %+v", d)
	}
	if m.input.value() != "" {
		t.Fatalf("the paste leaked into the composer: %q", m.input.value())
	}
	run(m, press(m, tea.KeyEnter, 0))
	if len(agent.connected) == 0 || agent.connected[0] != "free:OPENROUTER_API_KEY=sk-or-pasted" {
		t.Fatalf("connected %q", agent.connected)
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
