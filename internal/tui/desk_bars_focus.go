package tui

import (
	"slices"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// The bars, by keyboard. esc steps out of what has the keys: from a window's top level, or from an
// empty input in Chat, the keyboard goes down to the bars. There the open windows' tabs and the
// dock's apps are one row: ←/→ walk along it, enter switches to a window or opens an app, delete
// closes the window under the cursor, and ↑ or esc goes back into the window. Any other key goes
// back too, and does what it does there, so typing never gets lost on the way.

// barFocus is whether the keyboard is on the bars, and where along them.
type barFocus struct {
	on bool
	at int
}

// barItem is one stop on the bars: a window's tab (tab ≥ 0) or a dock app (app set).
type barItem struct {
	tab int
	app string
}

// barItems are the stops in order: every tab, Chat first, then every app of the dock.
func (m *Model) barItems() []barItem {
	var items []barItem
	for i := 0; i <= len(m.windows); i++ {
		items = append(items, barItem{tab: i})
	}
	for _, app := range append(slices.Clone(dockApps), systemApps...) {
		if app.id != "chat" { // Chat is the first tab already
			items = append(items, barItem{tab: -1, app: app.id})
		}
	}
	return items
}

// stepOut puts the keyboard on the bars, at the focused window's tab.
func (m *Model) stepOut() {
	m.bar = barFocus{on: true, at: m.active}
}

// barKey handles a key while the keyboard is on the bars; false hands it back to the window.
func (m *Model) barKey(msg tea.KeyPressMsg) (tea.Cmd, bool) {
	items := m.barItems()
	m.bar.at = min(max(m.bar.at, 0), len(items)-1)
	switch msg.String() {
	case "left", "shift+tab":
		m.bar.at = max(m.bar.at-1, 0)
	case "right", "tab":
		m.bar.at = min(m.bar.at+1, len(items)-1)
	case "home":
		m.bar.at = 0
	case "end":
		m.bar.at = len(items) - 1
	case "enter", "space":
		it := items[m.bar.at]
		m.bar.on = false
		if it.tab >= 0 {
			m.focus(it.tab)
			return nil, true
		}
		return m.runAction(it.app), true
	case "delete":
		if it := items[m.bar.at]; it.tab > 0 {
			m.closeWindow(it.tab)
			m.bar.at = min(m.bar.at, len(m.windows))
		}
	case "up", "esc":
		m.bar.on = false
	default:
		m.bar.on = false
		return nil, false
	}
	return nil, true
}

// barFocused is whether the bar item for tab i (or app id) is where the keyboard is.
func (m *Model) barFocused(tab int, app string) bool {
	if !m.bar.on {
		return false
	}
	items := m.barItems()
	if m.bar.at < 0 || m.bar.at >= len(items) {
		return false
	}
	it := items[m.bar.at]
	return (tab >= 0 && it.tab == tab) || (app != "" && it.app == app)
}

// barCursor is how the item under the keyboard is drawn on a bar: in the focus colour, reversed.
func (m *Model) barCursor(label string) string {
	return lipgloss.NewStyle().Foreground(m.th.Bg).Background(m.th.BorderFocus).Bold(true).Render(label)
}
