package tui

import (
	"github.com/charmbracelet/x/ansi"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
)

func chatWith(t *testing.T, replies ...string) *Model {
	t.Helper()
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	for _, r := range replies {
		a := &assistantItem{}
		a.append(r)
		m.tr.items = append(m.tr.items, a)
	}
	screen(m) // draws, so the body is known
	return m
}

// row finds the screen row showing text.
func row(t *testing.T, m *Model, text string) (y, x int) {
	t.Helper()
	for i, line := range m.bodyLines {
		plain := stripForTest(line)
		if c := strings.Index(plain, text); c >= 0 {
			return i + 1, utf8.RuneCountInString(plain[:c]) + 1 // cells, not bytes: the gutter is a multi-byte dot
		}
	}
	t.Fatalf("no row shows %q in %q", text, m.bodyLines)
	return
}

func stripForTest(s string) string { return ansiStrip(s) }

func drag(m *Model, x1, y1, x2, y2 int) tea.Cmd {
	m.Update(tea.MouseClickMsg{X: x1, Y: y1, Button: tea.MouseLeft})
	m.Update(tea.MouseMotionMsg{X: x2, Y: y2, Button: tea.MouseLeft})
	_, cmd := m.Update(tea.MouseReleaseMsg{X: x2, Y: y2, Button: tea.MouseLeft})
	return cmd
}

func TestDraggingOverTheTranscriptHighlightsAndCopiesWhatItCovers(t *testing.T) {
	m := chatWith(t, "alpha beta gamma", "delta epsilon")
	y1, x1 := row(t, m, "beta")
	y2, x2 := row(t, m, "delta")
	cmd := drag(m, x1, y1, x2+4, y2)
	if cmd == nil {
		t.Fatal("releasing a drag should copy")
	}
	if got := m.selectedText(); got != "beta gamma\n\n● delta" {
		t.Fatalf("selected %q", got)
	}
	if !m.sel.shown {
		t.Fatal("the selection should stay highlighted")
	}
	if strings.Count(screen(m), "\x1b[7m") == 0 && !strings.Contains(m.View().Content, "\x1b[7m") {
		t.Fatal("the highlight should be drawn in reverse video")
	}
}

func TestAClickThatNeverMovesIsNotASelection(t *testing.T) {
	m := chatWith(t, "alpha beta gamma")
	y, x := row(t, m, "beta")
	if cmd := drag(m, x, y, x, y); cmd != nil || m.sel.shown {
		t.Fatalf("a click selected: %+v", m.sel)
	}
}

func TestEscScrollingAndSendingClearTheHighlight(t *testing.T) {
	for name, clear := range map[string]func(m *Model){
		"esc":    func(m *Model) { press(m, tea.KeyEscape, 0) },
		"wheel":  func(m *Model) { m.Update(tea.MouseWheelMsg{Button: tea.MouseWheelUp}) },
		"resize": func(m *Model) { m.Update(tea.WindowSizeMsg{Width: 90, Height: 24}) },
		"typing": func(m *Model) { typeText(m, "x") },
	} {
		m := chatWith(t, "alpha beta gamma")
		y, x := row(t, m, "alpha")
		drag(m, x, y, x+8, y)
		if !m.sel.shown {
			t.Fatalf("%s: nothing selected", name)
		}
		clear(m)
		if m.sel.shown {
			t.Errorf("%s should clear the highlight", name)
		}
	}
}

func TestSelectionIsOnlyInTheTranscript(t *testing.T) {
	m := chatWith(t, "alpha beta gamma")
	m.runAction("tasks") // a window is focused: no transcript to select
	m.Update(tea.MouseClickMsg{X: 5, Y: 3, Button: tea.MouseLeft})
	if m.sel.pressed {
		t.Fatal("a window is not the transcript")
	}
}

func TestClickingTheComposerPlacesTheCursorOnThatRowAndCell(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 60, Height: 24})
	typeText(m, "first line")
	m.input.area.InsertString("\nsecond line here")
	m.input.fit()
	screen(m)
	time.Sleep(40 * time.Millisecond) // the zone worker scans asynchronously
	box := m.zones.frame.Get("composer")
	if box.IsZero() {
		t.Fatal("the composer is not a click zone")
	}
	// Row 0 of the text is one below the box's top border; the text starts after the border and "› ".
	m.Update(tea.MouseClickMsg{X: box.StartX + 1 + 2 + 6, Y: box.StartY + 1, Button: tea.MouseLeft})
	if m.input.area.Line() != 0 || m.input.area.Column() != 6 {
		t.Fatalf("first line, column 6 expected; line %d column %d", m.input.area.Line(), m.input.area.Column())
	}
	m.Update(tea.MouseClickMsg{X: box.StartX + 1 + 2 + 3, Y: box.StartY + 2, Button: tea.MouseLeft})
	if m.input.area.Line() != 1 || m.input.area.Column() != 3 {
		t.Fatalf("second line, column 3 expected; line %d column %d", m.input.area.Line(), m.input.area.Column())
	}
	m.Update(tea.MouseClickMsg{X: box.StartX + 40, Y: box.StartY + 2, Button: tea.MouseLeft})
	if m.input.area.Column() != len("second line here") {
		t.Fatalf("a click past the end goes to the end, column %d", m.input.area.Column())
	}
}

func ansiStrip(s string) string { return ansi.Strip(s) }
