package tui

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/gallery"
)

// wallpaperNone is the choice of no photo: the theme's plain ground.
const wallpaperNone = "off"

// wallpaperPicker (/wallpaper) chooses the photo behind the screen: taking turns (the default), any
// one photo, or none. Moving the cursor shows the choice at once, as the theme picker does; esc
// puts back what was there, enter keeps it and remembers it (config.State.Wallpaper).
type wallpaperPicker struct {
	choices  []string // "" (take turns), photo ids, wallpaperNone
	cursor   int
	original string
}

func newWallpaperPicker(m *Model) *wallpaperPicker {
	choices := []string{""}
	for _, p := range gallery.Photos {
		choices = append(choices, p.ID)
	}
	choices = append(choices, wallpaperNone)
	cursor := 0
	for i, c := range choices {
		if c == m.wallChoice {
			cursor = i
		}
	}
	return &wallpaperPicker{choices: choices, cursor: cursor, original: m.wallChoice}
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
		return "Take turns", "antiquity and sci-fi, a new one every few minutes"
	case wallpaperNone:
		return "None", "the theme's plain ground"
	}
	p, _ := gallery.ByID(choice)
	return p.Title, "by " + p.By + " · " + p.Theme
}

func (w *wallpaperPicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		m.wallChoice = w.original // a preview is not a choice
		return true, nil
	case "enter":
		title, _ := w.label(w.choices[w.cursor])
		return true, m.setWallpaper(w.choices[w.cursor], "Wallpaper: "+title)
	case "up", "k", "shift+tab":
		w.cursor = (w.cursor - 1 + len(w.choices)) % len(w.choices)
	case "down", "j", "tab":
		w.cursor = (w.cursor + 1) % len(w.choices)
	default:
		return false, nil
	}
	m.wallChoice = w.choices[w.cursor]
	return false, nil
}

func (w *wallpaperPicker) rowCount() int { return len(w.choices) }
func (w *wallpaperPicker) choose(m *Model, i int) tea.Cmd {
	w.cursor = i
	m.overlay = nil
	title, _ := w.label(w.choices[i])
	return m.setWallpaper(w.choices[i], "Wallpaper: "+title)
}

func (w *wallpaperPicker) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 64)
	inner := max(width-4, 10)
	// As many rows as fit, scrolled to keep the cursor in view.
	room := max(m.height-8, 3)
	first := min(max(w.cursor-room/2, 0), max(len(w.choices)-room, 0))
	var b strings.Builder
	for i := first; i < min(first+room, len(w.choices)); i++ {
		title, detail := w.label(w.choices[i])
		text := ansi.Truncate(title, inner-2, "…")
		rest := ansi.Truncate(" · "+detail, max(inner-2-ansi.StringWidth(text), 0), "…")
		row := th.Body.Render("  "+text) + th.Faint.Render(rest)
		if i == w.cursor {
			row = th.Title.Render("› "+text) + th.Faint.Render(rest)
		}
		b.WriteString(mark(m.zones.dialog, rowID(i), row) + "\n")
	}
	b.WriteString(th.Faint.Render("↑/↓ preview · enter keep · esc revert · w in the Gallery"))
	return frame(th, "Wallpaper", b.String(), width)
}
