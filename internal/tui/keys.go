package tui

import (
	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"

	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

// keyMap is every shortcut, declared once: dispatch matches against it and `help` renders it, so
// the status-bar hint and the help overlay cannot drift from what the keys actually do.
type keyMap struct {
	Send, Newline, Complete, Cancel, Interrupt, Quit         key.Binding
	Mode, Expand, Palette, Help, Themes                      key.Binding
	PageUp, PageDown, LineUp, LineDown, Top, Bottom, History key.Binding
}

func newKeyMap() keyMap {
	b := func(help, desc string, keys ...string) key.Binding {
		return key.NewBinding(key.WithKeys(keys...), key.WithHelp(help, desc))
	}
	return keyMap{
		Send:      b("enter", "send", "enter"),
		Newline:   b("shift+enter", "new line", "shift+enter", "alt+enter", "ctrl+j"),
		Complete:  b("tab", "complete", "tab"),
		Cancel:    b("esc", "stop · live", "esc"),
		Interrupt: b("ctrl+c", "stop · clear · quit", "ctrl+c"),
		Quit:      b("ctrl+d", "quit", "ctrl+d"),
		Mode:      b("shift+tab", "mode", "shift+tab"),
		Expand:    b("ctrl+o", "expand output", "ctrl+o"),
		Palette:   b("ctrl+p", "commands", "ctrl+p"),
		Help:      b("?", "help", "?"),
		Themes:    b("ctrl+t", "themes", "ctrl+t"),
		PageUp:    b("pgup", "page up", "pgup"),
		PageDown:  b("pgdn", "page down", "pgdown"),
		LineUp:    b("alt+↑", "line up", "alt+up"),
		LineDown:  b("alt+↓", "line down", "alt+down"),
		Top:       b("ctrl+home", "top", "ctrl+home"),
		Bottom:    b("ctrl+end", "bottom", "ctrl+end"),
		History:   b("↑/↓", "earlier messages", "up", "down"),
	}
}

// shortFor is the status-bar hint for what the screen is doing now: only keys that do something.
func (k keyMap) shortFor(m *Model) []key.Binding {
	switch {
	case m.phase == busy:
		return []key.Binding{k.Cancel, k.Expand, k.Palette}
	case !m.tr.following():
		return []key.Binding{withHelp(k.Cancel, "esc", "back to live"), k.PageUp, k.PageDown}
	default:
		return []key.Binding{k.Mode, k.Palette, k.Help}
	}
}

func withHelp(b key.Binding, keys, desc string) key.Binding {
	b.SetHelp(keys, desc)
	return b
}

// fullHelp is the help overlay's columns.
func (k keyMap) fullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Send, k.Newline, k.Complete, k.History, k.Interrupt, k.Quit},
		{k.Cancel, k.Mode, k.Expand, k.Palette, k.Themes, k.Help},
		{k.PageUp, k.PageDown, k.LineUp, k.LineDown, k.Top, k.Bottom},
	}
}

// newHelp is a help model in the theme's colours.
func newHelp(th theme.Theme) help.Model {
	h := help.New()
	h.Styles = help.DefaultStyles(!th.Light)
	h.Styles.ShortKey = th.Key
	h.Styles.ShortDesc = th.Faint
	h.Styles.ShortSeparator = th.Faint
	h.Styles.FullKey = th.Key
	h.Styles.FullDesc = th.Body
	h.Styles.FullSeparator = th.Faint
	h.ShortSeparator = " · "
	return h
}
