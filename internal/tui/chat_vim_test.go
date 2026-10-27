package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// TestVimNormalModeEdits: each case is text with | at the cursor, the keys, and the result.
func TestVimNormalModeEdits(t *testing.T) {
	split := func(s string) ([]rune, int) {
		i := strings.Index(s, "|")
		return []rune(s[:i] + s[i+1:]), len([]rune(s[:i]))
	}
	for _, c := range []struct {
		before, keys, after string
		typing              bool
	}{
		{"fix the |parser now", "w", "fix the parser |now", false},
		{"fix the parser |now", "b", "fix the |parser now", false},
		{"fix |the parser", "e", "fix th|e parser", false},
		{"fix the |parser", "0", "|fix the parser", false},
		{"fix the |parser", "$", "fix the parse|r", false},
		{"  fix |it", "^", "  |fix it", false},
		{"fix the |parser now", "dw", "fix the |now", false},
		{"fix the |parser now", "cw", "fix the | now", true},
		{"one\n|two\nthree", "dd", "one\n|three", false},
		{"one\n|two", "dd", "|one", false},
		{"one\n|two\nthree", "yyp", "one\ntwo\n|two\nthree", false},
		{"ab|c", "x", "a|b", false},
		{"ab|cd", "D", "ab|", false},
		{"ab|cd", "C", "ab|", true},
		{"one\nt|wo", "k", "o|ne\ntwo", false},
		{"o|ne\ntwo", "j", "one\nt|wo", false},
		{"one\ntw|o", "ggx", "|ne\ntwo", false},
		{"o|ne", "o", "one\n|", true},
		{"o|ne", "A", "one|", true},
		{"fix |it", "dwu", "fix |it", false},
		{"fix |it", "a", "fix i|t", true},
		{"fix |it", "q", "fix |it", false},
	} {
		text, cursor := split(c.before)
		var v vimState
		typing := false
		for _, k := range c.keys {
			text, cursor, typing = v.vimEdit(text, cursor, string(k))
		}
		got := string(text[:cursor]) + "|" + string(text[cursor:])
		if got != c.after || typing != c.typing {
			t.Errorf("%q + %s = %q (typing %v), want %q (typing %v)", c.before, c.keys, got, typing, c.after, c.typing)
		}
	}
}

func pressVim(m *Model, key string) {
	switch key {
	case "esc":
		m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	case "enter":
		m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	default:
		m.Update(tea.KeyPressMsg{Code: []rune(key)[0], Text: key})
	}
}

func TestVimKeysInTheInput(t *testing.T) {
	m, agent := newTestModel(t)
	m.vim.on = true
	typeText(m, "fix the parser now")
	pressVim(m, "esc")
	if !m.vim.normal || !strings.Contains(screen(m), "NORMAL") {
		t.Fatal("esc on a non-empty input did not enter normal mode")
	}
	for _, k := range []string{"0", "w", "w", "d", "w"} {
		pressVim(m, k)
	}
	if got := m.input.value(); got != "fix the now" {
		t.Fatalf("after 0wwdw: %q", got)
	}
	pressVim(m, "i")
	typeText(m, "lexer ")
	if got := m.input.value(); got != "fix the lexer now" || m.vim.normal {
		t.Fatalf("after i: %q (normal %v)", got, m.vim.normal)
	}
	pressVim(m, "esc")
	_, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	run(m, cmd)
	if len(agent.prompts) != 1 || agent.prompts[0] != "fix the lexer now" || m.vim.normal {
		t.Fatalf("enter in normal mode did not send: %v (normal %v)", agent.prompts, m.vim.normal)
	}
	// esc on an empty input keeps its meaning: it steps out to the bars.
	pressVim(m, "esc")
	if m.vim.normal {
		t.Fatal("esc on an empty input entered normal mode")
	}
}
