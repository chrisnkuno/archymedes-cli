package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestADiffLineCommentGoesWithTheNextMessage(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	openChangesAt(t, m, changedRepo(t))
	// ] picks the first code line, then on to the added "return 11".
	for !strings.Contains(screen(m), "▸") || !strings.Contains(m.changesWindow().diffs["app.go"].refs[m.changesWindow().line].code, "return 11") {
		before := m.changesWindow().line
		deliver(m, press(m, ']', 0))
		if m.changesWindow().line == before {
			t.Fatalf("] stopped before the added line:\n%s", screen(m))
		}
	}
	deliver(m, press(m, 'c', 0))
	if _, ok := m.overlay.(*commentDialog); !ok {
		t.Fatalf("c opens the comment:\n%s", screen(m))
	}
	typeText(m, "eleven is wrong, keep 1")
	deliver(m, press(m, tea.KeyEnter, 0))
	if len(m.comments) != 1 || !strings.Contains(screen(m), "◆") || !strings.Contains(screen(m), "1 comment for your next message") {
		t.Fatalf("the comment is kept and marked: %v\n%s", m.comments, screen(m))
	}
	deliver(m, press(m, tea.KeyEscape, 0)) // back to the chat
	typeText(m, "please fix")
	deliver(m, press(m, tea.KeyEnter, 0))
	agent.mu.Lock()
	sent := agent.prompts[len(agent.prompts)-1]
	agent.mu.Unlock()
	for _, want := range []string{"please fix", "My comments on the diff:", "app.go:3", "`func One() int { return 11 }`", "eleven is wrong, keep 1"} {
		if !strings.Contains(sent, want) {
			t.Fatalf("message lacks %q:\n%s", want, sent)
		}
	}
	if len(m.comments) != 0 {
		t.Fatal("comments are sent once")
	}
}

func TestEmptyingACommentRemovesIt(t *testing.T) {
	m, _ := newTestModel(t)
	ref := lineRef{true, 3, '+', "x"}
	m.comments = []reviewComment{{"a.go", ref, "first"}}
	d := newCommentDialog(m, "a.go", ref)
	if d.input.Value() != "first" {
		t.Fatal("an existing comment is shown for editing")
	}
	d.input.SetValue("")
	d.handle(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	if len(m.comments) != 0 {
		t.Fatal(m.comments)
	}
}

func TestDiffLineRefsFollowTheDrawnRows(t *testing.T) {
	m, _ := newTestModel(t)
	patch := "diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n\\ No newline at end of file\n"
	rows, refs := diffRows(m, patch, 80), diffLineRefs(patch)
	if len(rows) != len(refs) {
		t.Fatalf("%d rows, %d refs", len(rows), len(refs))
	}
	want := []lineRef{{}, {true, 1, ' ', "keep"}, {true, 2, '-', "old"}, {true, 2, '+', "new"}, {}}
	for i := range want {
		if refs[i] != want[i] {
			t.Fatalf("ref %d = %+v, want %+v", i, refs[i], want[i])
		}
	}
}
