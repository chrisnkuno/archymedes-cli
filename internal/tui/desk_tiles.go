package tui

import (
	"fmt"
	"image/color"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// Tiles: a grid of square cards, moved through with all four arrows. A tile is a picture (drawn
// for its size) over a one-line caption; the one under the cursor is framed in the focus colour.
// Pickers whose choices are best seen rather than read (themes, wallpapers) are tile grids.
//
// Squares on a terminal: a cell is about twice as tall as it is wide, so a tile tileArtCols wide
// and tileArtRows tall in half-block glyphs (two pixels a cell) is close to square on screen.

const (
	tileArtCols = 15
	tileArtRows = 7
	tileGap     = 1
)

// tile is one card: what it is (id), the caption under it, and its picture.
type tile struct {
	id      string
	caption string
	// art draws the picture in cols×rows cells; nil leaves the space blank with the caption.
	art func(m *Model, cols, rows int) []string
}

// tileGrid is the grid: its tiles, the one under the cursor, and how it was last laid out
// (columns follow the width, so ↑/↓ move by a row of whatever is on screen).
type tileGrid struct {
	tiles  []tile
	cursor int
	cols   int // tiles a row, as last drawn
	top    int // first row drawn
	// inWindow marks the tiles in the frame's zones ("tile:<i>") rather than a dialog's (rowID),
	// for a grid in an app window; clicked resolves them.
	inWindow bool
}

// zoneID is tile i's click target.
func (g *tileGrid) zoneID(i int) string {
	if g.inWindow {
		return fmt.Sprintf("tile:%d", i)
	}
	return rowID(i)
}

// clicked is the tile a click in a window landed on.
func (g *tileGrid) clicked(m *Model, msg tea.MouseClickMsg) (int, bool) {
	for i := range g.tiles {
		if m.zones.frame.Get(g.zoneID(i)).InBounds(msg) {
			return i, true
		}
	}
	return 0, false
}

// tileOuter is one tile's width and height on screen, border included.
func tileOuter() (int, int) { return tileArtCols + 2, tileArtRows + 3 }

// gridWidth is the dialog width that holds up to want tiles a row on this screen, frame included.
func gridWidth(m *Model, want int) int {
	w, _ := tileOuter()
	cols := min(want, columnsFor(m.width-8))
	return overlayWidth(m, cols*w+(cols-1)*tileGap+4)
}

// columnsFor is how many tiles fit a row in width.
func columnsFor(width int) int {
	w, _ := tileOuter()
	return max((width+tileGap)/(w+tileGap), 1)
}

// move applies a navigation key and reports whether it was one: ←/→ one tile (wrapping), ↑/↓ one
// row (staying put at the edge), home/end the first and last, pgup/pgdn a screenful of rows.
func (g *tileGrid) move(key string, rowsShown int) bool {
	n := len(g.tiles)
	if n == 0 {
		return false
	}
	cols := max(g.cols, 1)
	switch key {
	case "left", "h", "shift+tab":
		g.cursor = (g.cursor - 1 + n) % n
	case "right", "l", "tab":
		g.cursor = (g.cursor + 1) % n
	case "up", "k":
		if g.cursor-cols >= 0 {
			g.cursor -= cols
		}
	case "down", "j":
		switch {
		case g.cursor+cols < n:
			g.cursor += cols
		case g.cursor/cols < (n-1)/cols:
			g.cursor = n - 1 // the last row is short: land on its last tile
		}
	case "home":
		g.cursor = 0
	case "end":
		g.cursor = n - 1
	case "pgup":
		g.cursor = max(g.cursor-cols*max(rowsShown, 1), g.cursor%cols)
	case "pgdown":
		g.cursor = min(g.cursor+cols*max(rowsShown, 1), n-1)
	default:
		return false
	}
	return true
}

// view draws the grid in width×height cells, scrolled to keep the cursor's row in view. Each tile
// is a click target marked rowID(i) in the dialog's zones.
func (g *tileGrid) view(m *Model, width, height int) string {
	tw, thgt := tileOuter()
	g.cols = columnsFor(width)
	rowsShown := max(height/(thgt), 1)
	rows := (len(g.tiles) + g.cols - 1) / g.cols
	at := g.cursor / g.cols
	if at < g.top {
		g.top = at
	}
	if at >= g.top+rowsShown {
		g.top = at - rowsShown + 1
	}
	g.top = min(g.top, max(rows-rowsShown, 0))
	var lines []string
	for r := g.top; r < min(g.top+rowsShown, rows); r++ {
		var cards []string
		for c := range g.cols {
			i := r*g.cols + c
			if i >= len(g.tiles) {
				break
			}
			if c > 0 {
				cards = append(cards, strings.Repeat(" ", tileGap))
			}
			zones := m.zones.dialog
			if g.inWindow {
				zones = m.zones.frame
			}
			cards = append(cards, mark(zones, g.zoneID(i), g.card(m, i, tw)))
		}
		lines = append(lines, lipgloss.JoinHorizontal(lipgloss.Top, cards...))
	}
	return strings.Join(lines, "\n")
}

// card is tile i in its frame: the focus colour and a heavier edge under the cursor.
func (g *tileGrid) card(m *Model, i, outer int) string {
	th := m.th
	t := g.tiles[i]
	var art []string
	if t.art != nil {
		art = t.art(m, tileArtCols, tileArtRows)
	}
	for len(art) < tileArtRows {
		art = append(art, strings.Repeat(" ", tileArtCols))
	}
	caption := ansi.Truncate(t.caption, tileArtCols, "…")
	style, border := th.Faint, lipgloss.RoundedBorder()
	edge := th.BorderColor
	if i == g.cursor {
		style, border, edge = th.Title, lipgloss.ThickBorder(), th.BorderFocus
	}
	pad := max(tileArtCols-ansi.StringWidth(caption), 0)
	caption = style.Render(strings.Repeat(" ", pad/2) + caption + strings.Repeat(" ", pad-pad/2))
	body := strings.Join(append(art[:tileArtRows], caption), "\n")
	return lipgloss.NewStyle().Border(border).BorderForeground(edge).Width(outer).Render(body)
}

// iconArt is a tile for something that is not a picture: a symbol in its colour, and up to four
// short lines under it, each centred.
func iconArt(symbol string, tint color.Color, lines ...string) func(*Model, int, int) []string {
	return func(m *Model, cols, rows int) []string {
		center := func(text string, style lipgloss.Style) string {
			text = ansi.Truncate(text, cols, "…")
			pad := max(cols-ansi.StringWidth(text), 0)
			return strings.Repeat(" ", pad/2) + style.Render(text) + strings.Repeat(" ", pad-pad/2)
		}
		out := []string{"", center(symbol, lipgloss.NewStyle().Foreground(tint).Bold(true)), ""}
		for _, line := range lines {
			out = append(out, center(line, m.th.Faint))
		}
		for i := range out {
			if out[i] == "" {
				out[i] = strings.Repeat(" ", cols)
			}
		}
		if len(out) > rows {
			out = out[:rows]
		}
		return out
	}
}

// wrapTo splits text into at most n lines of width cells, at spaces.
func wrapTo(text string, width, n int) []string {
	var lines []string
	line := ""
	for _, word := range strings.Fields(text) {
		switch {
		case line == "":
			line = word
		case ansi.StringWidth(line)+1+ansi.StringWidth(word) <= width:
			line += " " + word
		default:
			lines, line = append(lines, line), word
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	if len(lines) > n {
		lines = lines[:n]
		lines[n-1] = ansi.Truncate(lines[n-1]+" …", width, "…")
	}
	return lines
}
