package tui

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/project"
	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// The Finder (alt+g, /finder): everything Friday can open, as a grid of icons, the way a desktop's
// file browser shows a folder. Places down the side (apps, commands, sessions, files, themes,
// modes); typing searches all of them at once. The arrows move through the grid (← at its edge
// steps into the places, → steps back), enter opens, space looks inside without opening, and in
// Files enter goes into a folder and backspace comes out of it.

const finderSidebar = 18 // the places' width, its gap included

// finderItem is one icon: what it is called, the line under it, what a quick look says, and what
// opening it does. dir is set for a folder in Files; file for a file.
type finderItem struct {
	name, note, about string
	art               func(*Model, int, int) []string
	dir, file         string
	open              func(m *Model) tea.Cmd
}

type finderPlace struct {
	id, symbol, name string
	group            string
}

var finderPlaces = []finderPlace{
	{"apps", "◆", "Apps", "Favourites"},
	{"commands", "/", "Commands", "Favourites"},
	{"sessions", "↺", "Sessions", "Favourites"},
	{"files", "▤", "Files", "Favourites"},
	{"themes", "◐", "Themes", "Looks"},
	{"modes", "◎", "Modes", "Looks"},
}

type finder struct {
	place   int
	sidebar bool // the places have the keyboard, not the grid
	search  textinput.Model
	dir     string // the folder shown in Files, "" for the project's top
	items   []finderItem
	grid    tileGrid
	looking bool // a quick look at the item under the cursor
}

func newFinder(m *Model) *finder {
	in := textinput.New()
	in.Placeholder = "search"
	in.Prompt = "⌕ "
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Prompt, s.Focused.Text, s.Focused.Placeholder = m.th.Key, m.th.Body, m.th.Faint
	s.Blurred = s.Focused
	in.SetStyles(s)
	in.Focus()
	f := &finder{search: in}
	f.reload(m)
	return f
}

// openFinder shows the Finder and reads what it lists beyond apps and commands.
func (m *Model) openFinder() tea.Cmd {
	m.openOverlay(newFinder(m))
	return m.startMenuSources()
}

// reload lists the place (or the search) again, keeping the cursor on the same name when it is there.
func (f *finder) reload(m *Model) {
	var keep string
	if f.grid.cursor < len(f.items) {
		keep = f.items[f.grid.cursor].name
	}
	if q := strings.TrimSpace(f.search.Value()); q != "" {
		f.items = f.searchAll(m, q)
	} else {
		f.items = f.list(m, finderPlaces[f.place].id)
	}
	f.grid.tiles = f.grid.tiles[:0]
	for i, it := range f.items {
		f.grid.tiles = append(f.grid.tiles, tile{id: strconv.Itoa(i), caption: it.name, art: it.art})
	}
	f.grid.cursor = 0
	for i, it := range f.items {
		if it.name == keep {
			f.grid.cursor = i
		}
	}
	f.grid.top = 0
}

// list is a place's icons.
func (f *finder) list(m *Model, place string) []finderItem {
	th := m.th
	var out []finderItem
	switch place {
	case "apps":
		pal := finderPalette(th)
		for i, app := range append(slices.Clone(dockApps), systemApps...) {
			id := app.id
			a, _ := findAction(id)
			keys := keyLabel(m.keys.keysFor(a))
			out = append(out, finderItem{name: app.name, note: keys, about: "Opens the " + app.name + " app (" + keys + ").",
				art:  finderArt(appIcon(app.icon, pal[i%len(pal)], pal[(i+2)%len(pal)]), keys),
				open: func(m *Model) tea.Cmd { return m.runAction(id) }})
		}
	case "commands":
		for _, c := range append(slices.Clone(commands), m.custom...) {
			c := c
			usage := "/" + c.name
			if c.args != "" {
				usage += " " + c.args
			}
			out = append(out, finderItem{name: "/" + c.name, note: ansi.Truncate(c.args, tileArtCols, "…"), about: usage + "\n\n" + c.help,
				art: finderArt(commandIcon(c.name), c.args),
				open: func(m *Model) tea.Cmd {
					if c.args != "" && !slices.Contains([]string{"mode", "model", "diff", "undo", "theme"}, c.name) {
						// It needs words after it: put it in the input for them.
						m.input.take()
						m.input.area.InsertString("/" + c.name + " ")
						return nil
					}
					return c.run(m, "")
				}})
		}
	case "sessions":
		now := time.Now()
		for _, s := range m.recentSessions {
			if s.ID == m.session.ID {
				continue
			}
			s := s
			title := strings.Join(strings.Fields(s.Title), " ")
			when := relativeTime(s.UpdatedAt, now)
			out = append(out, finderItem{name: title, note: when, about: title + "\n\nLast used " + when + ". enter continues it.",
				art:  finderArt(sessionIcon(hue(th, s.ID)), when),
				open: func(m *Model) tea.Cmd { return m.resumeSession(s.ID) }})
		}
	case "files":
		out = f.folder(m)
	case "themes":
		for _, name := range theme.Names() {
			name := name
			note := ""
			if name == th.Name {
				note = "● in use"
			}
			out = append(out, finderItem{name: name, note: note, about: "The " + name + " theme. enter switches to it.", art: themeArt(name),
				open: func(m *Model) tea.Cmd { return m.cmdTheme(name) }})
		}
	case "modes":
		for _, mt := range modeTiles {
			mt := mt
			out = append(out, finderItem{name: mt.name, about: mt.name + " mode: " + mt.does + ".",
				art:  iconArt(mt.symbol, th.ModeColor(mt.name), wrapTo(mt.does, tileArtCols, 3)...),
				open: func(m *Model) tea.Cmd { return m.setMode(mt.name) }})
		}
	}
	return out
}

// folder is the folders, then the files, directly in f.dir.
func (f *finder) folder(m *Model) []finderItem {
	prefix := ""
	if f.dir != "" {
		prefix = f.dir + "/"
	}
	counts := map[string]int{}
	var dirs, files []string
	for _, p := range m.knownFiles {
		rest, ok := strings.CutPrefix(p, prefix)
		if !ok {
			continue
		}
		if name, _, nested := strings.Cut(rest, "/"); nested {
			if counts[name] == 0 {
				dirs = append(dirs, name)
			}
			counts[name]++
		} else {
			files = append(files, rest)
		}
	}
	slices.Sort(dirs)
	slices.Sort(files)
	var out []finderItem
	for _, d := range dirs {
		full := prefix + d
		note := plural(counts[d], "file")
		out = append(out, finderItem{name: d, note: note, dir: full, about: full + "/\n\n" + note + " inside.",
			art: finderArt(folderIcon(hue(m.th, d)), note)})
	}
	for _, name := range files {
		full := prefix + name
		out = append(out, finderItem{name: name, file: full, about: full, art: finderArt(fileIcon(name), ""),
			open: func(m *Model) tea.Cmd { return m.openFile(full) }})
	}
	return out
}

// searchAll is every place's icons whose name holds the query, best first; files join once known.
func (f *finder) searchAll(m *Model, query string) []finderItem {
	var all []finderItem
	for _, p := range finderPlaces {
		if p.id != "files" {
			all = append(all, f.list(m, p.id)...)
		}
	}
	for _, p := range m.knownFiles {
		p := p
		all = append(all, finderItem{name: p, file: p, about: p, art: finderArt(fileIcon(p), ""),
			open: func(m *Model) tea.Cmd { return m.openFile(p) }})
	}
	entries := make([]paletteEntry, len(all))
	for i, it := range all {
		entries[i] = paletteEntry{label: it.name, section: strconv.Itoa(i)}
	}
	var out []finderItem
	for _, e := range rankEntries(entries, query) {
		i, _ := strconv.Atoi(e.section)
		it := all[i]
		if it.file != "" {
			it.name = it.file[strings.LastIndex(it.file, "/")+1:] // a tile shows the name; quick look the path
			it.note = ansi.Truncate(it.file, tileArtCols, "…")
		}
		out = append(out, it)
		if len(out) == 120 {
			break
		}
	}
	return out
}

// --- keys ---

func (f *finder) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	k := msg.String()
	switch k {
	case "ctrl+c", "alt+g":
		return true, nil
	case "esc":
		switch {
		case f.looking:
			f.looking = false
		case f.search.Value() != "":
			f.search.SetValue("")
			f.reload(m)
		default:
			return true, nil
		}
		return false, nil
	case "tab", "shift+tab":
		f.sidebar = !f.sidebar
		return false, nil
	case "enter":
		if f.sidebar {
			f.sidebar = false
			return false, nil
		}
		return f.open(m)
	case "space":
		if f.search.Value() == "" {
			f.looking = !f.looking
			return false, nil
		}
	case "backspace", "alt+up":
		if f.search.Value() == "" || k == "alt+up" {
			f.up(m)
			return false, nil
		}
	}
	if f.sidebar {
		return false, f.placeKey(m, k)
	}
	if f.navigates(k) {
		if k == "left" && f.grid.cursor%max(f.grid.cols, 1) == 0 {
			f.sidebar = true // off the grid's left edge, into the places
			return false, nil
		}
		f.grid.move(k, 1)
		return false, nil
	}
	// Anything else is typed into the search.
	before := f.search.Value()
	var cmd tea.Cmd
	f.search, cmd = f.search.Update(msg)
	if f.search.Value() != before {
		f.looking = false
		f.reload(m)
	}
	return false, cmd
}

// navigates is whether k moves the cursor rather than typing.
func (f *finder) navigates(k string) bool {
	return slices.Contains([]string{"left", "right", "up", "down", "home", "end", "pgup", "pgdown"}, k)
}

// placeKey moves through the places; each one shows as soon as it is chosen.
func (f *finder) placeKey(m *Model, k string) tea.Cmd {
	switch k {
	case "up", "k":
		f.choosePlace(m, (f.place-1+len(finderPlaces))%len(finderPlaces))
	case "down", "j":
		f.choosePlace(m, (f.place+1)%len(finderPlaces))
	case "right", "l":
		f.sidebar = false
	}
	return nil
}

func (f *finder) choosePlace(m *Model, i int) {
	f.place, f.dir, f.looking = i, "", false
	f.search.SetValue("")
	f.reload(m)
}

// up leaves a folder for the one around it.
func (f *finder) up(m *Model) {
	if f.dir == "" {
		return
	}
	left := f.dir
	if i := strings.LastIndex(f.dir, "/"); i >= 0 {
		f.dir = f.dir[:i]
	} else {
		f.dir = ""
	}
	f.reload(m)
	for i, it := range f.items {
		if it.dir == left {
			f.grid.cursor = i // back on the folder just left
		}
	}
}

// open opens the icon under the cursor: a folder in place, anything else after the Finder closes.
func (f *finder) open(m *Model) (bool, tea.Cmd) {
	if len(f.items) == 0 {
		return false, nil
	}
	it := f.items[f.grid.cursor]
	if it.dir != "" {
		if f.search.Value() != "" {
			f.search.SetValue("")
			f.place = slices.IndexFunc(finderPlaces, func(p finderPlace) bool { return p.id == "files" })
		}
		f.dir, f.looking = it.dir, false
		f.reload(m)
		return false, nil
	}
	m.overlay = nil // what it opens may be a window or another dialog
	return false, it.open(m)
}

// click picks a place, or the icon under the pointer; a click on the icon already picked opens it.
func (f *finder) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	for i := range finderPlaces {
		if m.zones.dialog.Get(fmt.Sprintf("place:%d", i)).InBounds(msg) {
			f.choosePlace(m, i)
			return nil
		}
	}
	for i := range f.grid.tiles {
		if m.zones.dialog.Get(f.grid.zoneID(i)).InBounds(msg) {
			f.sidebar = false
			if i == f.grid.cursor {
				_, cmd := f.open(m)
				return cmd
			}
			f.grid.cursor = i
		}
	}
	return nil
}

// --- view ---

func (f *finder) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 124)
	inner := max(width-4, 20)
	// The frame, its title, the toolbar, two rules and the status line take 8 rows; the rest holds
	// whole rows of tiles, and no more, so the window has no empty band under the grid.
	_, tileHeight := tileOuter()
	height := max((m.height-8)/tileHeight, 1) * tileHeight
	tool := f.toolbar(m, inner)
	rule := th.Faint.Render(strings.Repeat("─", inner))
	gridWidth := max(inner-finderSidebar, tileOuterWidth())
	var main string
	switch {
	case f.looking && len(f.items) > 0:
		main = f.quickLook(m, gridWidth, height)
	case len(f.items) == 0:
		main = th.Faint.Render(f.empty(m))
	default:
		main = f.grid.view(m, gridWidth, height)
	}
	main = lipgloss.NewStyle().Width(gridWidth).Height(height).MaxHeight(height).Render(main)
	body := lipgloss.JoinHorizontal(lipgloss.Top, f.places(m, height), main)
	return frame(th, "Finder", tool+"\n"+rule+"\n"+body+"\n"+rule+"\n"+f.status(m, inner), width)
}

func tileOuterWidth() int { w, _ := tileOuter(); return w }

// toolbar is where you are, as a path, and the search.
func (f *finder) toolbar(m *Model, width int) string {
	th := m.th
	back := th.Faint.Render("‹ ")
	if f.dir != "" {
		back = th.Key.Render("‹ ")
	}
	p := finderPlaces[f.place]
	crumbs := []string{th.Strong.Render(p.symbol + " " + p.name)}
	if f.search.Value() != "" {
		crumbs = []string{th.Strong.Render("⌕ Searching everything")}
	} else if f.dir != "" {
		for _, part := range strings.Split(f.dir, "/") {
			crumbs = append(crumbs, th.Body.Render(part))
		}
	}
	path := back + strings.Join(crumbs, th.Faint.Render(" › "))
	searchWidth := min(32, width/3)
	f.search.SetWidth(max(searchWidth-3, 4))
	box := lipgloss.NewStyle().Background(th.Surface).Width(searchWidth).Render(f.search.View())
	room := max(width-searchWidth-1, 1)
	path = ansi.TruncateLeft(path, max(ansi.StringWidth(path)-room, 0), "…")
	return padRight(path, room) + " " + box
}

// places is the sidebar: each place with how many it holds, the one shown marked.
func (f *finder) places(m *Model, height int) string {
	th := m.th
	var lines []string
	group := ""
	for i, p := range finderPlaces {
		if p.group != group {
			if group != "" {
				lines = append(lines, "")
			}
			group = p.group
			lines = append(lines, th.Faint.Render(p.group))
		}
		count := len(f.list(m, p.id))
		if p.id == "files" {
			count = len(m.knownFiles)
		}
		row := " " + p.symbol + " " + padRight(p.name, 9) + fmt.Sprintf("%4d", count)
		style := th.Body
		if i == f.place && f.search.Value() == "" {
			style = lipgloss.NewStyle().Foreground(th.Text).Background(th.Tint(th.Primary, 0.3)).Bold(true)
			if f.sidebar {
				style = style.Background(th.Tint(th.Primary, 0.55))
			}
		}
		lines = append(lines, mark(m.zones.dialog, fmt.Sprintf("place:%d", i), style.Render(padRight(row, finderSidebar-2))))
	}
	return lipgloss.NewStyle().Width(finderSidebar).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}

// quickLook is the icon under the cursor, large, beside what it is; a file shows its first lines.
func (f *finder) quickLook(m *Model, width, height int) string {
	th := m.th
	it := f.items[f.grid.cursor]
	icon := (&tileGrid{tiles: []tile{{caption: it.name, art: it.art}}}).card(m, 0, tileOuterWidth())
	textWidth := max(width-tileOuterWidth()-3, 10)
	text := []string{th.Title.Render(ansi.Truncate(it.name, textWidth, "…")), ""}
	for _, para := range strings.Split(it.about, "\n") {
		text = append(text, wrapped(th.Body, para, textWidth)...)
	}
	switch {
	case it.file != "":
		if body, note := project.Preview(m.projectRoot(), it.file, 64<<10); body != "" {
			text = append(text, "")
			text = append(text, m.codeLines(it.file, body, textWidth)...)
		} else if note != "" {
			text = append(text, th.Faint.Render(note))
		}
	case it.dir != "":
		saved := f.dir
		f.dir = it.dir
		var names []string
		for _, inside := range f.folder(m) {
			names = append(names, inside.name)
		}
		f.dir = saved
		text = append(text, "", th.Faint.Render(ansi.Truncate(strings.Join(names, "  "), textWidth*3, "…")))
	}
	if len(text) > height {
		text = text[:height]
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, icon, "   ", strings.Join(text, "\n"))
}

// empty says why there is nothing to show.
func (f *finder) empty(m *Model) string {
	switch {
	case f.search.Value() != "":
		return "Nothing matches " + strconv.Quote(f.search.Value()) + "."
	case finderPlaces[f.place].id == "files" && m.knownFiles == nil:
		return m.spin.View() + " reading the project…"
	case finderPlaces[f.place].id == "sessions":
		return "No earlier sessions in this project yet."
	}
	return "Empty."
}

// status is how many there are, the one picked, and the keys that matter here.
func (f *finder) status(m *Model, width int) string {
	th := m.th
	count := plural(len(f.items), "item")
	picked := ""
	if len(f.items) > 0 {
		picked = " · " + th.Body.Render(f.items[f.grid.cursor].name)
	}
	keys := "←↑↓→ move · enter open · space look · tab places · type to search · esc close"
	if f.dir != "" {
		keys = "backspace up · " + keys
	}
	line := th.Faint.Render(count) + picked
	room := max(width-ansi.StringWidth(line)-2, 0)
	return line + "  " + th.Faint.Render(ansi.Truncate(keys, room, "…"))
}
