package tui

import (
	"math/rand"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

func newTestComposer() composer {
	th, _ := theme.Load("")
	c := newComposer(th)
	c.setWidth(40)
	return c
}

func TestTheBoxGrowsWithItsContentUpToItsLimit(t *testing.T) {
	c := newTestComposer()
	c.area.SetValue("one line")
	if c.area.Height() != 1 {
		t.Fatalf("height %d", c.area.Height())
	}
	c.area.SetValue(strings.Repeat("line\n", 30))
	if c.area.Height() != maxComposerLines {
		t.Fatalf("height %d, want the limit %d", c.area.Height(), maxComposerLines)
	}
}

// Sentences wrap by word, so they take more rows than their length divided by the width; the box
// used to be sized by that division and hid the first row of anything that wrapped early.
func TestEveryWordOfAMessageThatFitsIsOnScreen(t *testing.T) {
	words := strings.Fields("the parser drops a trailing comma when the input spans several lines and nobody noticed until the release candidate shipped to users")
	r := rand.New(rand.NewSource(7))
	for trial := 0; trial < 300; trial++ {
		c := newTestComposer()
		c.setWidth(10 + r.Intn(50))
		var parts []string
		for n := 1 + r.Intn(40); n > 0; n-- {
			word := words[r.Intn(len(words))]
			if r.Intn(9) == 0 {
				word += "\n"
			}
			parts = append(parts, word)
		}
		text := strings.ReplaceAll(strings.Join(parts, " "), "\n ", "\n")
		c.area.SetValue(text)
		height := c.area.Height()
		if height < 1 || height > maxComposerLines {
			t.Fatalf("trial %d: height %d", trial, height)
		}
		if height == maxComposerLines {
			continue // scrolled: the box is as tall as it gets
		}
		shown := strings.Fields(ansi.Strip(c.area.View()))
		if strings.Join(shown, " ") != strings.Join(strings.Fields(text), " ") {
			t.Fatalf("trial %d, width %d, height %d: shown %q, typed %q", trial, c.area.Width(), height, shown, strings.Fields(text))
		}
	}
}

func TestALineAsWideAsTheBoxKeepsItsFirstRow(t *testing.T) {
	c := newTestComposer()
	text := strings.Repeat("x", c.area.Width())
	c.area.SetValue(text)
	if !strings.Contains(ansi.Strip(c.area.View()), text) {
		t.Fatalf("height %d, view %q", c.area.Height(), ansi.Strip(c.area.View()))
	}
}

func TestMoreThanEightLinesCanBeWritten(t *testing.T) {
	c := newTestComposer()
	for i := 0; i < 20; i++ {
		c.update(tea.KeyPressMsg{Code: 'a', Text: "a"})
		c.update(tea.KeyPressMsg{Code: 'j', Mod: tea.ModCtrl})
	}
	if got := strings.Count(c.value(), "\n"); got != 20 {
		t.Fatalf("%d line breaks, want 20", got)
	}
	if c.area.Height() != maxComposerLines {
		t.Fatalf("height %d", c.area.Height())
	}
}

func TestAWindowsPasteKeepsOneBreakPerLine(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.PasteMsg{Content: "first\r\nsecond\r\n\r\nfourth\rfifth"})
	if got := m.input.value(); got != "first\nsecond\n\nfourth\nfifth" {
		t.Fatalf("%q", got)
	}
}

func TestABackslashBeforeEnterStartsANewLine(t *testing.T) {
	m, agent := newTestModel(t)
	typeText(m, "first sentence.\\")
	run(m, press(m, tea.KeyEnter, 0))
	if len(agent.prompts) != 0 || m.input.value() != "first sentence.\n" {
		t.Fatalf("prompts %q, input %q", agent.prompts, m.input.value())
	}
	typeText(m, "Second one.")
	run(m, press(m, tea.KeyEnter, 0))
	if len(agent.prompts) != 1 || agent.prompts[0] != "first sentence.\nSecond one." {
		t.Fatalf("prompts %q", agent.prompts)
	}
	// Only at the end: a backslash in the middle of what was typed is text.
	typeText(m, `C:\dir`)
	m.input.area.CursorStart()
	if m.input.continueLine() {
		t.Fatal("continued from the middle of the line")
	}
}

func TestTheNewLineKeyShownIsOneTheTerminalCanSend(t *testing.T) {
	m, _ := newTestModel(t)
	if m.newlineKey() != `\ enter` {
		t.Fatalf("before the terminal answers: %q", m.newlineKey())
	}
	m.Update(tea.KeyboardEnhancementsMsg{Flags: 1})
	if m.newlineKey() != "shift+enter" {
		t.Fatalf("with disambiguation: %q", m.newlineKey())
	}
}

func TestTakeEmptiesTheBoxAndKeepsHistoryWithoutDuplicates(t *testing.T) {
	c := newTestComposer()
	for _, text := range []string{"first", "second", "second", "  "} {
		c.area.SetValue(text)
		c.take()
	}
	if strings.Join(c.history, ",") != "first,second" {
		t.Fatalf("history %v", c.history)
	}
	if c.value() != "" {
		t.Fatal("the box should be empty")
	}
}

func TestUpAndDownBrowseHistoryOnlyOnASingleLine(t *testing.T) {
	c := newTestComposer()
	for _, text := range []string{"alpha", "beta"} {
		c.area.SetValue(text)
		c.take()
	}
	c.area.SetValue("draft")
	if !c.browse(-1) || c.value() != "beta" {
		t.Fatalf("up: %q", c.value())
	}
	if !c.browse(-1) || c.value() != "alpha" {
		t.Fatalf("up again: %q", c.value())
	}
	if !c.browse(1) || !c.browse(1) || c.value() != "draft" {
		t.Fatalf("down returns to the draft, got %q", c.value())
	}
	c.area.SetValue("two\nlines")
	if c.browse(-1) {
		t.Fatal("history must not steal the arrow keys from a multi-line message")
	}
	// One line that wraps: up moves through its rows first, and browses only from the top one.
	c.area.SetValue(strings.Repeat("word ", 30))
	if c.browse(-1) {
		t.Fatal("up on the last row of a wrapped line browsed history")
	}
	c.area.MoveToBegin()
	if !c.browse(-1) || c.value() != "beta" {
		t.Fatalf("up on the first row: %q", c.value())
	}
}

func TestSlashOffersCommandsAndAnAtMentionOffersFiles(t *testing.T) {
	c := newTestComposer()
	c.files = []string{"internal/tui/model.go", "README.md"}
	c.area.SetValue("/mo")
	c.refreshCompletions()
	names := []string{}
	for _, comp := range c.complete {
		names = append(names, comp.name)
	}
	if !strings.Contains(strings.Join(names, ","), "model") || !strings.Contains(strings.Join(names, ","), "mode") {
		t.Fatalf("completions %v", names)
	}
	c.area.SetValue("look at @read")
	c.refreshCompletions()
	if len(c.complete) == 0 || c.complete[0].path != "README.md" {
		t.Fatalf("mentions %+v", c.complete)
	}
	if !c.accept() || c.value() != "look at @README.md " {
		t.Fatalf("accepted %q", c.value())
	}
}

func TestCommandsAreUniqueAndEveryOneHasHelp(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range commands {
		if seen[c.name] {
			t.Errorf("duplicate command /%s", c.name)
		}
		seen[c.name] = true
		if c.help == "" || c.run == nil {
			t.Errorf("/%s lacks help or a handler", c.name)
		}
		if _, gone := notInThisInterface[c.name]; gone {
			t.Errorf("/%s is both implemented and listed as missing", c.name)
		}
	}
}

func TestMatchingCommandsPrefixesAndRefusesNonCommands(t *testing.T) {
	if got := matchingCommands("/"); len(got) != len(commands) {
		t.Fatalf("a bare slash lists all %d, got %d", len(commands), len(got))
	}
	for _, input := range []string{"hello", "/model x", "/a\nb"} {
		if got := matchingCommands(input); got != nil {
			t.Errorf("%q matched %d commands", input, len(got))
		}
	}
}
