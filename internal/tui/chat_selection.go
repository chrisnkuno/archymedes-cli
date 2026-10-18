package tui

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/mattn/go-runewidth"
)

// Mouse text selection in the transcript, and clicking to place the cursor in the composer.
//
// A drag over the transcript highlights what it covers and, on release, copies it to the clipboard
// (OSC 52, which works over ssh and in tmux). The highlight is kept in screen rows of what was last
// drawn, so anything that moves the text under it — scrolling, a new message, a resize — clears it
// rather than leaving a highlight on the wrong words.

type selection struct {
	pressed  bool // the button is down in the transcript
	dragging bool // and has moved: this is a selection, not a click
	shown    bool // a selection is on screen
	ar, ac   int  // anchor: body row, column
	hr, hc   int  // head
}

func (s *selection) clear() { *s = selection{} }

// ordered returns the selection's start and end, whichever way it was dragged.
func (s selection) ordered() (r1, c1, r2, c2 int) {
	r1, c1, r2, c2 = s.ar, s.ac, s.hr, s.hc
	if r1 > r2 || (r1 == r2 && c1 > c2) {
		r1, c1, r2, c2 = r2, c2, r1, c1
	}
	return
}

// bodyPoint maps a mouse position to a transcript row and column, or false outside the transcript.
func (m *Model) bodyPoint(x, y int) (row, col int, ok bool) {
	if m.activeWindow() != nil || m.overlay != nil || m.approval != nil || m.landingVisible() {
		return 0, 0, false
	}
	row = y - 1 // the top bar is row 0
	if row < 0 || row >= len(m.bodyLines) {
		return 0, 0, false
	}
	return row, max(x-1, 0), true // body rows carry a one-column margin
}

func (m *Model) selectPress(msg tea.MouseClickMsg) {
	m.sel.clear()
	if msg.Mouse().Button != tea.MouseLeft {
		return
	}
	if row, col, ok := m.bodyPoint(msg.Mouse().X, msg.Mouse().Y); ok {
		m.sel = selection{pressed: true, ar: row, ac: col, hr: row, hc: col}
	}
}

func (m *Model) selectDrag(msg tea.MouseMotionMsg) {
	if !m.sel.pressed {
		return
	}
	mouse := msg.Mouse()
	row := min(max(mouse.Y-1, 0), len(m.bodyLines)-1) // dragging past an edge sticks to it
	col := max(mouse.X-1, 0)
	m.sel.hr, m.sel.hc = row, col
	if row != m.sel.ar || col != m.sel.ac {
		m.sel.dragging, m.sel.shown = true, true
	}
}

// selectRelease ends a drag by copying what it covers; a press that never moved was a click.
func (m *Model) selectRelease() tea.Cmd {
	wasDrag := m.sel.dragging
	m.sel.pressed, m.sel.dragging = false, false
	if !wasDrag {
		m.sel.clear()
		return nil
	}
	text := m.selectedText()
	if strings.TrimSpace(text) == "" {
		m.sel.clear()
		return nil
	}
	lines := strings.Count(text, "\n") + 1
	return tea.Batch(tea.SetClipboard(text), m.toast(toastInfo, "Copied "+plural(lines, "line")+" · esc clears the highlight"))
}

// span is the columns [from, to) of row that the selection covers; to < 0 means to the line's end.
func (s selection) span(row, width int) (from, to int, ok bool) {
	r1, c1, r2, c2 := s.ordered()
	if row < r1 || row > r2 {
		return 0, 0, false
	}
	from, to = 0, width
	if row == r1 {
		from = c1
	}
	if row == r2 {
		to = c2 + 1
	}
	return from, max(to, from), true
}

// selectedText is the plain text under the selection, line by line, without trailing blanks.
func (m *Model) selectedText() string {
	var out []string
	for row, line := range m.bodyLines {
		plain := ansi.Strip(line)
		width := runewidth.StringWidth(plain)
		from, to, ok := m.sel.span(row, width)
		if !ok {
			continue
		}
		out = append(out, strings.TrimRight(ansi.Strip(ansi.Cut(line, from, min(to, width))), " "))
	}
	return strings.TrimRight(strings.Join(out, "\n"), "\n")
}

// highlight draws the selection over a body row.
func (m *Model) highlight(row int, line string) string {
	if !m.sel.shown {
		return line
	}
	width := runewidth.StringWidth(ansi.Strip(line))
	from, to, ok := m.sel.span(row, width)
	if !ok || from >= width {
		return line
	}
	to = min(to, width)
	style := lipgloss.NewStyle().Reverse(true)
	return ansi.Cut(line, 0, from) + style.Render(ansi.Strip(ansi.Cut(line, from, to))) + ansi.Cut(line, to, width)
}

// --- click to place the cursor ---

// placeCursor moves the composer's cursor to where a click landed. x and y are relative to the box's
// top-left corner; the box has a one-cell border and a two-column "› " marker before the text.
func (c *composer) placeCursor(x, y int) {
	row, col := y-1, x-1-2
	if row < 0 || col < -2 {
		return
	}
	col = max(col, 0)
	// The cursor's own screen row is only reported when the real cursor is in use.
	c.area.SetVirtualCursor(false)
	defer c.area.SetVirtualCursor(true)
	for range 200 {
		cursor := c.area.Cursor()
		if cursor == nil || cursor.Y == row {
			break
		}
		line, column := c.area.Line(), c.area.Column()
		if cursor.Y < row {
			c.area.CursorDown()
		} else {
			c.area.CursorUp()
		}
		if c.area.Line() == line && c.area.Column() == column {
			break // no further to go: the click was below or above the text
		}
	}
	info := c.area.LineInfo()
	text := []rune(strings.Split(c.area.Value(), "\n")[c.area.Line()])
	at, cells := info.StartColumn, 0
	for at < len(text) && at < info.StartColumn+info.Width && cells+runewidth.RuneWidth(text[at]) <= col {
		cells += runewidth.RuneWidth(text[at])
		at++
	}
	c.area.SetCursorColumn(at)
}
