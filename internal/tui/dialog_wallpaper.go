package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/gallery"
)

// wallpaperNone is the choice of no photo: the theme's plain ground.
const wallpaperNone = "off"

// wallpaperTurns prefixes a choice that takes turns within one theme: "turns:abstract".
const wallpaperTurns = "turns:"

// wallpaperPicker (/wallpaper) chooses the picture behind the screen: every theme taking turns (the
// default), one theme taking turns, any one picture, or none. Moving the cursor shows the choice at once, as the theme picker does; esc
// puts back what was there, enter keeps it and remembers it (config.State.Wallpaper).
type wallpaperPicker struct {
	choices  []string // "" (take turns), photo ids, wallpaperNone
	grid     tileGrid // one tile per choice, in the same order
	original string
}

func newWallpaperPicker(m *Model) *wallpaperPicker {
	choices := []string{""}
	// Abstract first: the theme most people come here for.
	order := []string{"abstract", "scifi", "greek"}
	for _, theme := range order {
		choices = append(choices, wallpaperTurns+theme)
	}
	for _, theme := range append(order, "math") {
		for _, p := range gallery.Photos {
			if p.Theme == theme {
				choices = append(choices, p.ID)
			}
		}
	}
	choices = append(choices, wallpaperNone)
	cursor := 0
	for i, c := range choices {
		if c == m.wallChoice {
			cursor = i
		}
	}
	w := &wallpaperPicker{choices: choices, original: m.wallChoice}
	for _, c := range choices {
		w.grid.tiles = append(w.grid.tiles, tile{id: c, caption: w.caption(c), art: wallpaperArt(c)})
	}
	w.grid.cursor = cursor
	return w
}

// caption is a tile's one line: ↻ for taking turns, the picture's title otherwise.
func (w *wallpaperPicker) caption(choice string) string {
	switch {
	case choice == "":
		return "↻ all themes"
	case choice == wallpaperNone:
		return "none"
	}
	if theme, ok := strings.CutPrefix(choice, wallpaperTurns); ok {
		return "↻ " + gallery.ThemeLabel(theme)
	}
	p, _ := gallery.ByID(choice)
	return p.Title
}

// wallpaperArt draws a choice's tile: the picture itself, or for taking turns a 2×2 mosaic of what
// takes turns; none is left blank, as the screen would be.
func wallpaperArt(choice string) func(*Model, int, int) []string {
	return func(m *Model, cols, rows int) []string {
		if choice == wallpaperNone {
			return nil
		}
		if p, ok := gallery.ByID(choice); ok {
			return m.photoLines(p, cols, rows)
		}
		var picks []gallery.Photo
		if theme, ok := strings.CutPrefix(choice, wallpaperTurns); ok {
			for _, p := range gallery.Photos {
				if p.Theme == theme && len(picks) < 4 {
					picks = append(picks, p)
				}
			}
		} else {
			for _, theme := range []string{"greek", "scifi", "abstract", "math"} {
				for _, p := range gallery.Photos {
					if p.Theme == theme {
						picks = append(picks, p)
						break
					}
				}
			}
		}
		return mosaic(m, picks, cols, rows)
	}
}

// mosaic is up to four pictures in two rows of two.
func mosaic(m *Model, picks []gallery.Photo, cols, rows int) []string {
	if len(picks) == 0 {
		return nil
	}
	left, top := cols/2, rows/2
	cell := func(i, w, h int) []string {
		lines := m.photoLines(picks[i%len(picks)], w, h)
		for len(lines) < h {
			lines = append(lines, strings.Repeat(" ", w))
		}
		return lines
	}
	var out []string
	for half, h := range []int{top, rows - top} {
		a, b := cell(half*2, left, h), cell(half*2+1, cols-left, h)
		for i := range h {
			out = append(out, a[i]+b[i])
		}
	}
	return out
}

// setWallpaper shows choice now and remembers it for the next start.
func (m *Model) setWallpaper(choice, note string) tea.Cmd {
	m.wallChoice = choice
	if m.opts.ConfigDir != "" {
		if err := config.UpdateState(m.opts.ConfigDir, func(s *config.State) { s.Wallpaper = choice }); err != nil {
			return m.toast(toastWarn, "Shown, but not remembered: "+err.Error())
		}
	}
	if m.opts.NoPhotos || m.opts.NoWallpaper {
		note += " · photos are off in this terminal (ARCHYMEDES_PHOTOS / ARCHYMEDES_WALLPAPER)"
	}
	return m.toast(toastInfo, note)
}

func (w *wallpaperPicker) label(choice string) (string, string) {
	switch choice {
	case "":
		return "Take turns", "antiquity, sci-fi and abstract, one after another"
	case wallpaperNone:
		return "None", "the theme's plain ground"
	}
	if theme, ok := strings.CutPrefix(choice, wallpaperTurns); ok {
		photos, drawn := 0, 0
		for _, p := range gallery.Photos {
			switch {
			case p.Theme != theme:
			case p.Generated():
				drawn++
			default:
				photos++
			}
		}
		detail := fmt.Sprintf("%d pictures, one after another", photos)
		if drawn > 0 {
			detail = fmt.Sprintf("%d photographs and %d drawn by Friday, one after another", photos, drawn)
		}
		return "Take turns: " + gallery.ThemeLabel(theme) + " only", detail
	}
	p, _ := gallery.ByID(choice)
	return p.Title, p.Byline() + " · " + gallery.ThemeLabel(p.Theme)
}

func (w *wallpaperPicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		m.wallChoice = w.original // a preview is not a choice
		return true, nil
	case "enter":
		title, _ := w.label(w.choices[w.grid.cursor])
		return true, m.setWallpaper(w.choices[w.grid.cursor], "Wallpaper: "+title)
	case "tab":
		w.grid.cursor = w.groupStart(1)
	case "shift+tab":
		w.grid.cursor = w.groupStart(-1)
	default:
		_, h := tileOuter()
		if !w.grid.move(msg.String(), max((m.height-8)/h, 1)) {
			return false, nil
		}
	}
	m.wallChoice = w.choices[w.grid.cursor]
	return false, nil
}

// group is which run of the list a choice is in: the ways of taking turns, one theme's pictures,
// or none. tab and shift+tab move between groups.
func (w *wallpaperPicker) group(choice string) string {
	switch {
	case choice == "" || strings.HasPrefix(choice, wallpaperTurns):
		return "turns"
	case choice == wallpaperNone:
		return wallpaperNone
	}
	p, _ := gallery.ByID(choice)
	return p.Theme
}

// groupStart is the first choice of the next group (by 1) or of this one's predecessor (by -1),
// wrapping around; shift+tab inside a group goes to its start first.
func (w *wallpaperPicker) groupStart(by int) int {
	n := len(w.choices)
	here := w.group(w.choices[w.grid.cursor])
	start := w.grid.cursor
	for start > 0 && w.group(w.choices[start-1]) == here {
		start--
	}
	if by < 0 {
		if start != w.grid.cursor {
			return start
		}
		prev := (start - 1 + n) % n
		for prev > 0 && w.group(w.choices[prev-1]) == w.group(w.choices[prev]) {
			prev--
		}
		return prev
	}
	i := w.grid.cursor
	for i < n && w.group(w.choices[i]) == here {
		i++
	}
	return i % n
}

func (w *wallpaperPicker) rowCount() int { return len(w.choices) }
func (w *wallpaperPicker) choose(m *Model, i int) tea.Cmd {
	w.grid.cursor = i
	m.overlay = nil
	title, _ := w.label(w.choices[i])
	return m.setWallpaper(w.choices[i], "Wallpaper: "+title)
}

func (w *wallpaperPicker) view(m *Model) string {
	th := m.th
	width := gridWidth(m, 4)
	inner := max(width-4, 10)
	grid := w.grid.view(m, inner, max(m.height-8, 1))
	// The tile under the cursor in full: its title, who made it, its theme.
	title, detail := w.label(w.choices[w.grid.cursor])
	text := ansi.Truncate(title, inner, "…")
	about := th.Strong.Render(text) + th.Faint.Render(ansi.Truncate(" · "+detail, max(inner-ansi.StringWidth(text), 0), "…"))
	hint := th.Faint.Render(ansi.Truncate("↑↓←→ preview · tab next theme · enter keep · esc revert", inner, "…"))
	return frame(th, "Wallpaper", grid+"\n"+about+"\n"+hint, width)
}
