package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

var streamedDocs = []string{
	"# Title\n\nA paragraph here.\n\n- one\n- two\n\nAnother paragraph.",
	"Intro\n\n```go\nfunc a() {}\n\nfunc b() {}\n```\n\nAfter code.",
	"1. first\n2. second\n\n3. third\n\nend",
	"Para one with **bold**.\n\n> quote\n\nPara three.",
	"Text\n\n## Heading two\n\nmore text",
	"- a\n  - nested\n- b\n\nTail with `code` and a [link](https://x.y).",
	"| a | b |\n|---|---|\n| 1 | 2 |\n\nafter table",
	"para\n\n---\n\nafter rule",
	"Here:\n\n```\nraw\n\n\nstill raw\n```\n\n```go\nx := 1\n```",
	"    indented code\n\n    more of it\n\nplain",
}

// A reply drawn while it streams in, with its finished blocks kept from earlier chunks, looks
// exactly as the same text drawn whole: at every chunk, not only at the end. Blank rows at the
// very end are left out of the comparison: a block of which only its marker has arrived ("#")
// draws as blank rows whole and as nothing yet streamed.
func TestAStreamedReplyLooksAsItWouldWhole(t *testing.T) {
	m, _ := newTestModel(t)
	ctx := renderCtx{th: m.th, md: m.md, width: 62}
	for _, doc := range streamedDocs {
		a := &assistantItem{open: true}
		for i := 0; i < len(doc); i += 7 {
			a.append(doc[i:min(i+7, len(doc))])
			got := trimBlankTail(ansi.Strip(strings.Join(a.render(ctx), "\n")))
			whole := &assistantItem{}
			whole.append(a.text.String())
			want := trimBlankTail(ansi.Strip(strings.Join(whole.render(ctx), "\n")))
			if got != want {
				t.Fatalf("%q at %d:\nstreamed:\n%s\nwhole:\n%s", doc, i, got, want)
			}
		}
	}
}

func TestSettledSplitNeverCutsInsideAFenceOrIndentedText(t *testing.T) {
	for text, want := range map[string]int{
		"one\n\ntwo":                   5,
		"```\na\n\nb\n```":             0,
		"```\na\n```\n\nafter":         11,
		"para\n\n    code":             0,
		"one\n\ntwo\n\n":               5,
		"no blank line at all":         0,
		"~~~\nx\n\n~~~\n\n```\n\nopen": 12,
		"- a\n\n- b":                   0,
	} {
		if got := settledSplit(text); got != want {
			t.Errorf("%q: %d, want %d", text, got, want)
		}
	}
}

func trimBlankTail(s string) string {
	lines := strings.Split(s, "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}
