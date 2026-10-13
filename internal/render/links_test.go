package render

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

func TestLinksAreOSC8AndLeaveTheTextAlone(t *testing.T) {
	file := FileLink(lipgloss.NewStyle(), "src/app.go", "/home/p", "src/app.go")
	if !strings.Contains(file, "\x1b]8;;file:///home/p/src/app.go") || ansi.Strip(file) != "src/app.go" {
		t.Fatalf("%q", file)
	}
	if FileLink(lipgloss.NewStyle(), "x", "", "x") != "x" {
		t.Fatal("no root, no link")
	}
	text := LinkURLs(lipgloss.NewStyle(), "ready at http://127.0.0.1:4173/, then stop.")
	if !strings.Contains(text, "\x1b]8;;http://127.0.0.1:4173/") || ansi.Strip(text) != "ready at http://127.0.0.1:4173/, then stop." {
		t.Fatalf("%q / %q", text, ansi.Strip(text))
	}
}

func TestPathTreeNestsAListingAndLeavesProseAlone(t *testing.T) {
	th, _ := theme.Load(theme.DefaultName)
	tree := PathTree(th, []string{"src/", "src/app.go", "src/util/str.go", "README.md"})
	plain := ansi.Strip(strings.Join(tree, "\n"))
	for _, want := range []string{"src/", "util/", "str.go", "README.md", "├──", "└──"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("lacks %q:\n%s", want, plain)
		}
	}
	if strings.Count(plain, "src/") != 1 {
		t.Fatalf("directory repeated:\n%s", plain)
	}
	if PathTree(th, []string{"No files matched: try another pattern", "really"}) != nil {
		t.Fatal("prose drawn as a tree")
	}
}
