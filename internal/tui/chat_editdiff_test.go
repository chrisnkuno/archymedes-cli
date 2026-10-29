package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

func TestEditPatchKeepsContextAndCounts(t *testing.T) {
	changes, _ := editChanges("edit_file", map[string]any{"path": "a.go", "oldText": "a\nb\nc\n", "newText": "a\nB\nc\nd\n"})
	text, added, removed := editPatch(changes)
	if added != 2 || removed != 1 {
		t.Fatalf("counts +%d −%d, want +2 −1:\n%s", added, removed, text)
	}
	want := "@@ -0,3 +0,4 @@\n a\n-b\n+B\n c\n+d\n"
	if text != want {
		t.Fatalf("patch\n%q\nwant\n%q", text, want)
	}
}

func TestEditPatchPlacesEachChangeInTheWrittenFile(t *testing.T) {
	root := t.TempDir()
	written := "one\ntwo\nthree\nFOUR\nfive\nsix\nSEVEN\neight\n"
	if err := os.WriteFile(filepath.Join(root, "f.txt"), []byte(written), 0o644); err != nil {
		t.Fatal(err)
	}
	item := &toolItem{name: "edit_file", done: true, args: map[string]any{"path": "f.txt", "edits": []any{
		map[string]any{"oldText": "four", "newText": "FOUR"},
		map[string]any{"oldText": "seven", "newText": "SEVEN"},
	}}}
	attachDiff(item, root)
	if !strings.Contains(item.diff, "@@ -4,1 +4,1 @@") || !strings.Contains(item.diff, "@@ -7,1 +7,1 @@") {
		t.Fatalf("each change should carry its line in the file:\n%s", item.diff)
	}
	rows := diffRows(testTheme(), item.diff, 60)
	if got := ansi.Strip(rows[1]); !strings.HasPrefix(got, "   4      -four") {
		t.Fatalf("the removed line shows its old number: %q", got)
	}
}

func TestEditPatchShiftsOldNumbersByEarlierChanges(t *testing.T) {
	changes := []editChange{{old: "x\n", new: "x\ny\nz\n", at: 2}, {old: "q\n", new: "Q\n", at: 10}}
	text, _, _ := editPatch(changes)
	// The first change added two lines, so the second's old line is two above its new one.
	if !strings.Contains(text, "@@ -8,1 +10,1 @@") {
		t.Fatalf("old number not shifted:\n%s", text)
	}
}

func TestEditPatchUnplacedChangeHasNoNumbers(t *testing.T) {
	item := &toolItem{name: "edit_file", done: true, args: map[string]any{"path": "missing.txt", "oldText": "a", "newText": "b"}}
	attachDiff(item, t.TempDir())
	for _, row := range diffRows(testTheme(), item.diff, 60) {
		if strings.ContainsAny(ansi.Strip(row)[:9], "0123456789") {
			t.Fatalf("an unplaced change must not show numbers: %q", ansi.Strip(row))
		}
	}
}

func TestEditPatchLeavesOutLongUnchangedStretches(t *testing.T) {
	var old, repl []string
	for i := range 40 {
		old = append(old, "line"+string(rune('a'+i%26)))
	}
	repl = append(repl, old...)
	repl[1], repl[38] = "CHANGED1", "CHANGED2"
	text, added, removed := editPatch([]editChange{{old: strings.Join(old, "\n"), new: strings.Join(repl, "\n"), at: 1}})
	if added != 2 || removed != 2 || strings.Count(text, "@@ ") != 2 {
		t.Fatalf("two hunks, +2 −2 expected:\n%s", text)
	}
	if strings.Count(text, "\n") > 2*(1+2+2*editContext) {
		t.Fatalf("unchanged middle should be left out:\n%s", text)
	}
}

func TestWriteIsTheWholeFileAdded(t *testing.T) {
	item := &toolItem{name: "write_file", done: true, args: map[string]any{"path": "n.txt", "content": "a\nb\n"}}
	attachDiff(item, t.TempDir())
	if item.added != 2 || item.removed != 0 || !strings.HasPrefix(item.diff, "@@ -0,0 +1,2 @@") {
		t.Fatalf("write: +%d −%d\n%s", item.added, item.removed, item.diff)
	}
}

func TestFailedOrOtherCallsGetNoDiff(t *testing.T) {
	for _, item := range []*toolItem{
		{name: "edit_file", done: true, isError: true, args: map[string]any{"oldText": "a", "newText": "b"}},
		{name: "read_file", done: true, args: map[string]any{"path": "x"}},
	} {
		attachDiff(item, t.TempDir())
		if item.diff != "" {
			t.Errorf("%s (error %v) got a diff", item.name, item.isError)
		}
	}
}

// TestLineOpsReconstructBothSides: whatever the inputs, the kept and removed lines are the old
// text and the kept and added lines the new one, in order.
func TestLineOpsReconstructBothSides(t *testing.T) {
	cases := [][2]string{{"", "a"}, {"a", ""}, {"a\nb\nc", "c\nb\na"}, {"x\ny\nx\ny", "y\nx\ny\nx"}, {"same", "same"}}
	for _, c := range cases {
		a, b := splitLines(c[0]), splitLines(c[1])
		var gotA, gotB []string
		for _, op := range lineOps(a, b) {
			if op.kind != '+' {
				gotA = append(gotA, op.text)
			}
			if op.kind != '-' {
				gotB = append(gotB, op.text)
			}
		}
		if strings.Join(gotA, "\n") != strings.Join(a, "\n") || strings.Join(gotB, "\n") != strings.Join(b, "\n") {
			t.Errorf("%q → %q: ops do not rebuild both sides", c[0], c[1])
		}
	}
}

func testTheme() theme.Theme {
	th, _ := theme.Load("")
	return th
}
