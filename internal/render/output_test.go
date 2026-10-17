package render

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

func TestExcerptClipsSaysWhatItHidAndNeutralisesEscapes(t *testing.T) {
	th, _ := theme.Load(theme.DefaultName)
	body := "one\n\x1b[2Jtwo\tx\n" + strings.Repeat("y", 100) + "\nfour\nfive\n"
	lines := Excerpt(th, body, 20, 3)
	if len(lines) != 4 {
		t.Fatalf("%d lines: %q", len(lines), lines)
	}
	if strings.Contains(lines[1], "\x1b[2J") {
		t.Fatal("tool output escape reached the screen")
	}
	if w := ansi.StringWidth(lines[2]); w > 20 {
		t.Fatalf("line is %d wide", w)
	}
	if !strings.Contains(ansi.Strip(lines[3]), "2 more lines") {
		t.Fatal(lines[3])
	}
	if Excerpt(th, "\n\n", 20, 3) != nil {
		t.Fatal("blank output renders nothing")
	}
}

func TestDiffDetection(t *testing.T) {
	if !LooksLikeDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b") || LooksLikeDiff("exit 0\n-rw-r--r-- file") {
		t.Fatal("diff detection")
	}
}

func TestMarkdownRendersWithinWidth(t *testing.T) {
	th, _ := theme.Load(theme.DefaultName)
	md := NewMarkdown(th)
	out := md.Render("# Title\n\nSome **bold** text that is long enough to need wrapping at a narrow width.\n\n```go\nfmt.Println(1)\n```", 30)
	for _, line := range strings.Split(out, "\n") {
		if w := ansi.StringWidth(line); w > 30 {
			t.Fatalf("line %q is %d wide", ansi.Strip(line), w)
		}
	}
	if !strings.Contains(ansi.Strip(out), "Println") || strings.HasPrefix(out, "\n") {
		t.Fatalf("%q", out)
	}
}
