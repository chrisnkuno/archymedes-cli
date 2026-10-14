package tui

import (
	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
)

// The desktop: Chat is always the first window; Files, readers and the Keys app open as more
// windows beside it, each a tab in the top bar. Windows are full-width — a terminal is too small
// for overlap — and switch with a key or a click on their tab. Dialogs (approval, pickers, setup)
// still float over whichever window is focused.

// window is an app that fills the window area. title is its tab's label; key identifies it, so
// opening something already open focuses it instead of opening a second copy.
type window interface {
	overlay
	title() string
	key() string
}

// capturing is a window that, for now, wants every key — the Keys app waiting for a new binding.
type capturing interface{ capturing() bool }

func (p *pager) title() string     { return p.label }
func (p *pager) key() string       { return "reader:" + p.label }
func (f *filesView) title() string { return "Files" }
func (f *filesView) key() string   { return "files" }

// activeWindow is the focused app window, or nil when Chat is focused.
func (m *Model) activeWindow() window {
	if m.active <= 0 || m.active > len(m.windows) {
		return nil
	}
	return m.windows[m.active-1]
}

// openWindow focuses w, or the window already open under the same key.
func (m *Model) openWindow(w window) {
	for i, open := range m.windows {
		if open.key() == w.key() {
			m.windows[i] = w
			m.active = i + 1
			return
		}
	}
	m.windows = append(m.windows, w)
	m.active = len(m.windows)
}

// closeWindow closes the window at index i (1-based); focus moves to the one before it.
func (m *Model) closeWindow(i int) {
	if i <= 0 || i > len(m.windows) {
		return
	}
	m.windows = append(m.windows[:i-1], m.windows[i:]...)
	if m.active >= i {
		m.active--
	}
}

func (m *Model) focus(i int) {
	if count := len(m.windows) + 1; count > 0 {
		m.active = ((i % count) + count) % count
	}
}

// shellKey handles the keys that work from anywhere on the desktop; false when msg is not one.
func (m *Model) shellKey(msg tea.KeyPressMsg) (tea.Cmd, bool) {
	k := m.keys
	for _, b := range []struct {
		binding key.Binding
		id      string
	}{
		{k.Start, "start"}, {k.Chat, "chat"}, {k.Files, "files"}, {k.Search, "search"}, {k.Sessions, "sessions"},
		{k.Models, "models"}, {k.Themes, "themes"}, {k.Keys, "keys"}, {k.Stats, "stats"}, {k.Changes, "changes"}, {k.Gallery, "gallery"}, {k.Tasks, "tasks"}, {k.Settings, "settings"}, {k.Notifications, "notifications"}, {k.Help, "help"},
		{k.NextWindow, "next-window"}, {k.PrevWindow, "prev-window"}, {k.CloseWindow, "close-window"},
	} {
		if !key.Matches(msg, b.binding) {
			continue
		}
		// "?" is also something people type: it opens help only on Chat's empty input.
		if b.id == "help" && msg.String() == "?" && (m.activeWindow() != nil || m.input.value() != "") {
			continue
		}
		// In Chat, ctrl+w deletes a word in the input; only an app window is closed by it.
		if b.id == "close-window" && m.activeWindow() == nil {
			continue
		}
		return m.runAction(b.id), true
	}
	return nil, false
}

// runAction does what an app or window action means, however it was asked for: a key, a click on
// the dock, a row of the start menu.
func (m *Model) runAction(id string) tea.Cmd {
	switch id {
	case "start":
		m.openOverlay(newStartMenu(m))
		return m.startMenuSources()
	case "chat":
		m.active = 0
	case "files":
		return m.openFiles()
	case "search":
		p := m.transcriptPager()
		m.openWindow(p)
		_, cmd := p.handle(m, tea.KeyPressMsg{Code: '/', Text: "/"}) // straight into search
		return cmd
	case "sessions":
		return m.cmdResume("")
	case "models":
		return m.cmdModel("")
	case "themes":
		m.openOverlay(newThemePicker(m))
	case "keys":
		m.openWindow(newKeysApp(m))
	case "changes":
		return m.openChanges()
	case "gallery":
		return m.openGallery(m.photoIndex)
	case "stats":
		for _, w := range m.windows {
			if s, ok := w.(*statsApp); ok {
				m.openWindow(s) // keep the selected turn
				return nil
			}
		}
		m.openWindow(newStatsApp())
	case "settings":
		return m.openSettings()
	case "tasks":
		m.openWindow(&tasksApp{})
	case "notifications":
		m.openWindow(&notesApp{})
	case "help":
		m.openOverlay(helpOverlay{})
	case "next-window":
		m.focus(m.active + 1)
	case "prev-window":
		m.focus(m.active - 1)
	case "close-window":
		m.closeWindow(m.active)
	}
	return nil
}
