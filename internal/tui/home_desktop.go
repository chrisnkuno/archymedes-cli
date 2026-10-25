package tui

import (
	"fmt"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// The desktop: before the first message, the home screen is a desktop. Icons stand in columns down
// its left edge, the card with the prism is in the middle, and the tour's scenes play in a panel
// on the right. ↑ on an empty input steps onto the icons; the arrows move between them, enter
// opens one, and esc, ↓ past the last or typing goes back to the input. A click selects an icon and
// a second click opens it, as on any desktop.

const (
	deskIconW       = 12 // an icon's column: the 11-cell picture and a cell of gap
	deskIconH       = 7  // its rows: the 5-row picture, its name, a gap
	deskIconCompact = 5  // on a short screen: the picture's top, middle and foot, its name, a gap
	homeCardMin     = 44 // the card without the prism: a starter, with its border and margin
	homeCardArt     = 66 // the card with the prism beside the words
)

// desktopApp is one icon: the action it runs, its name, and its picture.
type desktopApp struct {
	id, name string
	art      func(m *Model, i int) []string
}

// desktopApps are the icons, in order: the project first, then what is opened most; the tour plays
// in its own panel beside the card, so it needs no icon.
func (m *Model) desktopApps() []desktopApp {
	app := func(glyph string) func(m *Model, i int) []string {
		return func(m *Model, i int) []string {
			pal := finderPalette(m.th)
			return appIcon(glyph, pal[i%len(pal)], pal[(i+2)%len(pal)])(m.th)
		}
	}
	project := "Project"
	if where := m.opts.Cwd; where != "" {
		project = filepath.Base(where)
	}
	return []desktopApp{
		{"files", project, func(m *Model, _ int) []string { return folderIcon(m.th.Warning)(m.th) }},
		{"changes", "Changes", app("±")},
		{"sessions", "Sessions", func(m *Model, _ int) []string { return sessionIcon(m.th.Secondary)(m.th) }},
		{"finder", "Finder", app("⌕")},
		{"models", "Models", app("◎")},
		{"themes", "Themes", app("◐")},
		{"settings", "Settings", app("⚙")},
		{"wallpaper", "Wallpaper", app("▣")},
		{"welcome", "Welcome", app("✦")},
	}
}

// deskState is where the desktop's keyboard is: on the icons or not, and which one is selected.
type deskState struct {
	focused bool
	cursor  int
	perCol  int // icons a column, as last drawn
}

// iconRows is how tall an icon is on a screen height rows tall: full size when two columns hold
// them all, compact when that is what it takes.
func iconRows(height, n int) int {
	if (height-1)/deskIconH*2 >= n {
		return deskIconH
	}
	return deskIconCompact
}

// homeLayout is how the home screen shares its width: the icons' columns on the left, the tour
// panel on the right, the card in between, with the prism when it has room.
type homeLayout struct {
	iconCols, iconsW, drawer int
	prism                    bool
}

// layoutHome gives the room out in order: the tour panel and the card with its prism first, then
// the icons; on a narrower screen the icons go to one column, then the prism goes, then the panel.
func (m *Model) layoutHome(width, height int) homeLayout {
	n := len(m.desktopApps())
	perCol := max((height-1)/iconRows(height, n), 1)
	cols := min((n+perCol-1)/perCol, 2)
	if height < deskIconCompact+1 {
		cols = 0
	}
	iconsW := func(c int) int {
		if c == 0 {
			return 0
		}
		return c*deskIconW + 1
	}
	drawer := func(c, card int) int { return min(tourMaxWidth, width-iconsW(c)-card-tourPhotoRoom) }
	if height >= 18 {
		// Every icon and the panel first, giving up the prism before either; then the panel alone.
		for _, card := range []int{homeCardArt, homeCardMin} {
			if d := drawer(cols, card); d >= tourMinWidth {
				return homeLayout{iconCols: cols, iconsW: iconsW(cols), drawer: d, prism: card == homeCardArt}
			}
		}
		if d := drawer(0, homeCardMin); d >= tourMinWidth {
			return homeLayout{drawer: d}
		}
	}
	for c := cols; c >= 0; c-- {
		if rest := width - iconsW(c); rest >= homeCardMin || c == 0 {
			return homeLayout{iconCols: c, iconsW: iconsW(c), prism: rest >= homeCardArt}
		}
	}
	return homeLayout{}
}

// desktopIcons draws the icons in cols columns of up to the height's worth each, top to bottom.
func (m *Model) desktopIcons(cols, height int) []string {
	th := m.th
	apps := m.desktopApps()
	rows := iconRows(height, len(apps))
	m.desk.perCol = max((height-1)/rows, 1)
	m.desk.cursor = min(m.desk.cursor, len(apps)-1)
	out := make([]string, height)
	for c := range cols {
		for r := range m.desk.perCol {
			i := c*m.desk.perCol + r
			if i >= len(apps) {
				break
			}
			var cell []string
			for k, line := range apps[i].art(m, i) {
				if rows == deskIconCompact && k%2 == 1 {
					continue // compact: the picture's top, middle and foot
				}
				cell = append(cell, centredCell(line, deskIconW))
			}
			name := ansi.Truncate(apps[i].name, deskIconW-2, "…")
			label := th.Body.Render(name)
			if i == m.desk.cursor && m.desk.focused {
				label = th.Pill(name, th.Primary) // selected, as a desktop shows it: the name in the accent
			}
			cell = append(cell, centredCell(label, deskIconW))
			block := strings.Split(mark(m.zones.frame, fmt.Sprintf("icon:%d", i), strings.Join(cell, "\n")), "\n")
			for j, line := range block {
				if y := 1 + r*rows + j; y < height {
					out[y] += strings.Repeat(" ", max(c*deskIconW+1-ansi.StringWidth(out[y]), 0)) + line
				}
			}
		}
	}
	return out
}

// centredCell is a styled line centred in width cells.
func centredCell(line string, width int) string {
	w := ansi.StringWidth(line)
	pad := max(width-w, 0)
	return strings.Repeat(" ", pad/2) + line + strings.Repeat(" ", pad-pad/2)
}

// deskKey moves on the desktop's icons. False when the key is not the desktop's: the input takes it.
func (m *Model) deskKey(msg tea.KeyPressMsg) (tea.Cmd, bool) {
	apps := m.desktopApps()
	per := max(m.desk.perCol, 1)
	i := m.desk.cursor
	switch msg.String() {
	case "up", "k":
		if i%per > 0 {
			m.desk.cursor--
		}
	case "down", "j":
		if i%per == per-1 || i == len(apps)-1 {
			m.desk.focused = false // past the last icon: back to the input
		} else {
			m.desk.cursor++
		}
	case "left", "h":
		if i-per >= 0 {
			m.desk.cursor -= per
		}
	case "right", "l":
		m.desk.cursor = min(i+per, len(apps)-1)
	case "home":
		m.desk.cursor = 0
	case "end":
		m.desk.cursor = len(apps) - 1
	case "enter", "space":
		return m.openIcon(i), true
	case "esc":
		m.desk.focused = false
	default:
		m.desk.focused = false // anything else is typing: it goes to the input
		return nil, false
	}
	return nil, true
}

// openIcon runs icon i's app; the keyboard goes back to the input behind it.
func (m *Model) openIcon(i int) tea.Cmd {
	apps := m.desktopApps()
	if i < 0 || i >= len(apps) {
		return nil
	}
	m.desk.focused = false
	return m.runAction(apps[i].id)
}

// deskClick is a click on an icon: the first selects it, a second on the selected one opens it.
func (m *Model) deskClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	for i := range m.desktopApps() {
		if m.zones.frame.Get(fmt.Sprintf("icon:%d", i)).InBounds(msg) {
			if m.desk.focused && m.desk.cursor == i {
				return m.openIcon(i), true
			}
			m.desk.focused, m.desk.cursor = true, i
			return nil, true
		}
	}
	return nil, false
}
