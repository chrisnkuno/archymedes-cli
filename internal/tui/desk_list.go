package tui

import (
	"fmt"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	zone "github.com/lrstanley/bubblezone/v2"
)

// Lists: every vertical list on the desktop is one of these, so they all move, scroll, click and
// look the same. ↑/↓ (and k/j) move a row, home/end to either end, pgup/pgdn a screenful; the
// wheel scrolls the view and the selection follows when it would leave it. A click selects a row;
// a click on the selected row opens it, as enter does. The selected row is a bar in the focus
// colour across the list's width. Rows the cursor should not stop on (section headers) are skipped.
//
// The list keeps no rows of its own: its owner says how many there are when it asks.

type listView struct {
	cursor int
	top    int // the first row drawn
	shown  int // rows as last drawn: a page for pgup/pgdn and the wheel
	wrap   bool
	// zone is the click target's prefix: row i is "<zone>:<i>".
	zone string
	// skip reports rows the cursor passes over; nil passes over none.
	skip func(i int) bool
}

func (l *listView) skips(i int) bool { return l.skip != nil && l.skip(i) }

// move applies a navigation key to a list of n rows and reports whether it was one.
func (l *listView) move(key string, n int) bool {
	if n == 0 {
		return false
	}
	page := max(l.shown-1, 1)
	switch key {
	case "up", "k", "ctrl+k":
		l.step(-1, n)
	case "down", "j", "ctrl+j":
		l.step(1, n)
	case "home":
		l.cursor = -1
		l.step(1, n)
	case "end":
		l.cursor = n
		l.step(-1, n)
	case "pgup":
		l.cursor = max(l.cursor-page, 0)
		l.settle(-1, n)
	case "pgdown":
		l.cursor = min(l.cursor+page, n-1)
		l.settle(1, n)
	default:
		return false
	}
	return true
}

// step moves one row by dir (±1), past skipped rows, wrapping or stopping at the ends.
func (l *listView) step(dir, n int) {
	at := l.cursor
	for range n {
		at += dir
		if at < 0 || at >= n {
			if !l.wrap || l.cursor < 0 || l.cursor >= n {
				return
			}
			at = (at + n) % n
		}
		if !l.skips(at) {
			l.cursor = at
			return
		}
	}
}

// settle moves the cursor off a skipped row, toward dir and then the other way.
func (l *listView) settle(dir, n int) {
	l.clamp(n)
	if !l.skips(l.cursor) {
		return
	}
	start := l.cursor
	l.step(dir, n)
	if l.cursor == start {
		l.step(-dir, n)
	}
}

// clamp keeps the cursor on a row of a list that may have shrunk.
func (l *listView) clamp(n int) {
	l.cursor = min(max(l.cursor, 0), max(n-1, 0))
}

// wheel scrolls the view of n rows by a notch; the selection moves only to stay in view.
func (l *listView) wheel(up bool, n int) {
	if up {
		l.top = max(l.top-wheelStep, 0)
	} else {
		l.top = max(min(l.top+wheelStep, n-l.shown), 0)
	}
	if l.cursor < l.top {
		l.cursor = l.top
		l.settle(1, n)
	} else if last := l.top + l.shown - 1; l.shown > 0 && l.cursor > last {
		l.cursor = last
		l.settle(-1, n)
	}
}

// window is the rows of n to draw in height: [from, to), scrolled as little as keeps the cursor in
// view (or where the wheel left it, when the cursor is in view there).
func (l *listView) window(n, height int) (from, to int) {
	l.shown = max(height, 1)
	l.clamp(n)
	if l.cursor < l.top {
		l.top = l.cursor
	}
	if l.cursor >= l.top+l.shown {
		l.top = l.cursor - l.shown + 1
	}
	l.top = max(min(l.top, n-l.shown), 0)
	return l.top, min(l.top+l.shown, n)
}

// row draws row i, text fitted to width: the bar when it is selected, and its click target.
func (l *listView) row(m *Model, zones *zone.Manager, i int, text string, width int) string {
	line := padRight(ansi.Truncate(text, width, "…"), width)
	if i == l.cursor && !l.skips(i) {
		line = selectedBar(m, line)
	}
	if zones == nil || l.zone == "" {
		return line
	}
	return mark(zones, fmt.Sprintf("%s:%d", l.zone, i), line)
}

// selectedBar is the one look of a selected row: a bar in the focus colour behind the text.
func selectedBar(m *Model, line string) string {
	return lipgloss.NewStyle().Background(m.th.Tint(m.th.Primary, 0.32)).Bold(true).Render(ansi.Strip(line))
}

// clicked is the row of n a click landed on, if any.
func (l *listView) clicked(zones *zone.Manager, msg tea.MouseClickMsg, n int) (int, bool) {
	for i := l.top; i < min(l.top+l.shown, n); i++ {
		if zones.Get(fmt.Sprintf("%s:%d", l.zone, i)).InBounds(msg) {
			return i, !l.skips(i)
		}
	}
	return 0, false
}

// clickRow selects row i, and reports whether it was already selected: a second click opens.
func (l *listView) clickRow(i int) (open bool) {
	open = l.cursor == i
	l.cursor = i
	return open
}
