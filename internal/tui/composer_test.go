package tui

import (
	"strings"
	"testing"

	"github.com/chrisnkuno/archymedes-cli/internal/theme"
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
	c.fit()
	if c.area.Height() != 1 {
		t.Fatalf("height %d", c.area.Height())
	}
	c.area.SetValue(strings.Repeat("line\n", 30))
	c.fit()
	if c.area.Height() != maxComposerLines {
		t.Fatalf("height %d, want the limit %d", c.area.Height(), maxComposerLines)
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
