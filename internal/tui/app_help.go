package tui

import (
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// Help (F8, ?, /help): every key, by group, and every command with what it does, in a reader
// window: it scrolls with the wheel and the arrows, and / searches it.

func (m *Model) openHelp() tea.Cmd {
	width := max(m.windowInside().Dx()-2, 40)
	h := m.help
	h.SetWidth(width)
	h.ShowAll = true
	lines := []string{m.th.Strong.Render("Keys"), ""}
	lines = append(lines, strings.Split(h.FullHelpView(m.keys.fullHelp()), "\n")...)
	lines = append(lines, "", m.th.Strong.Render("Commands"), "")
	for _, c := range append(slices.Clone(commands), m.custom...) {
		usage := "/" + c.name
		if c.args != "" {
			usage += " " + c.args
		}
		lines = append(lines, m.th.Key.Render(padRight(usage, 34))+m.th.Faint.Render(ansi.Truncate(c.help, max(width-34, 10), "…")))
	}
	m.openWindow(newPager(m, "Help", lines))
	return nil
}
