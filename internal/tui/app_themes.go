package tui

import (
	"image/color"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// The Themes app (F6, ctrl+t, /theme): every theme as a tile, a small screen in its colours. Moving
// previews it on the whole desktop at once; enter (or a second click) keeps it, esc puts back the
// one there was.

type themePicker struct {
	names    []string
	grid     tileGrid
	original string
}

func newThemePicker(m *Model) *themePicker {
	names := theme.Names()
	t := &themePicker{names: names, original: m.th.Name}
	for _, name := range names {
		t.grid.tiles = append(t.grid.tiles, tile{id: name, caption: name, art: themeArt(name)})
	}
	t.grid.cursor = max(slices.Index(names, m.th.Name), 0)
	t.grid.inWindow = true
	return t
}

func (t *themePicker) title() string { return "Themes" }
func (t *themePicker) key() string   { return "themes" }

func (t *themePicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "q", "ctrl+c":
		m.applyTheme(t.original) // a preview is not a choice
		return true, nil
	case "enter":
		return true, m.toast(toastInfo, "Theme: "+t.names[t.grid.cursor])
	}
	if !t.grid.move(msg.String(), t.rowsShown(m)) {
		return false, nil
	}
	m.applyTheme(t.names[t.grid.cursor])
	return false, nil
}

func (t *themePicker) rowsShown(m *Model) int {
	_, h := tileOuter()
	return max((m.windowHeight()-2)/h, 1)
}

func (t *themePicker) wheel(m *Model, up bool) tea.Cmd {
	t.grid.wheel(up)
	m.applyTheme(t.names[t.grid.cursor])
	return nil
}

// click previews a theme; a second click on it keeps it.
func (t *themePicker) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	i, ok := t.grid.clicked(m, msg)
	if !ok {
		return nil
	}
	if !t.grid.clickTile(i) {
		m.applyTheme(t.names[i])
		return nil
	}
	m.closeWindow(m.windowIndex(t))
	return m.toast(toastInfo, "Theme: "+t.names[i])
}

func (t *themePicker) view(m *Model) string {
	width, height := m.width, max(m.windowHeight(), 1)
	lines := strings.Split(t.grid.view(m, max(width-2, 1), max(height-1, 1)), "\n")
	for i := range lines {
		lines[i] = " " + lines[i]
	}
	lines = append(fitLines(lines, width, height-1), m.hintBar(width, button{"enter", "keep"}, button{"esc", "put back"}))
	return strings.Join(lines, "\n")
}

// themeArt draws a theme as a small screen: its primary bar, a title and a muted line on its
// background, its six colours as swatches, and its surface.
func themeArt(name string) func(*Model, int, int) []string {
	return func(_ *Model, cols, rows int) []string {
		th, ok := theme.Load(name)
		if !ok {
			return nil
		}
		on := func(bg color.Color) lipgloss.Style { return lipgloss.NewStyle().Background(bg).Width(cols) }
		fill := func(bg color.Color) string { return on(bg).Render("") }
		swatches := " "
		for _, c := range []color.Color{th.Primary, th.Secondary, th.Accent, th.Success, th.Warning, th.Error} {
			swatches += lipgloss.NewStyle().Foreground(c).Background(th.Bg).Render("██")
		}
		lines := []string{
			fill(th.Primary),
			on(th.Bg).Foreground(th.Text).Bold(true).Render(" Friday"),
			on(th.Bg).Foreground(th.Muted).Render(" shows its work"),
			fill(th.Bg),
			on(th.Bg).Render(swatches),
			fill(th.Bg),
			on(th.Surface).Foreground(th.Secondary).Render(" › ask"),
		}
		for len(lines) < rows {
			lines = append(lines, fill(th.Bg))
		}
		return lines[:rows]
	}
}

