package tui

import (
	"strings"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// Every shortcut is one row of `actions`: dispatch, the dock, the help, the start menu and the Keys
// app all read the same table, so what is shown is what works, and a rebinding changes all of them
// at once. Locked rows are the keys typing depends on; they can never be rebound, so no binding can
// lock someone out of the input or out of the Keys app.

type action struct {
	id, label, group string
	defaults         []string
	locked           bool
	field            func(*keyMap) *key.Binding
}

type keyMap struct {
	// Typing (locked).
	Send, Newline, Complete, Cancel, Interrupt, History key.Binding
	// Apps.
	Start, Chat, Files, Search, Sessions, Models, Themes, Keys, Help, Stats, Changes, Gallery, Tasks, Notifications, Settings, Providers key.Binding
	// Windows.
	NextWindow, PrevWindow, CloseWindow key.Binding
	// Session.
	Mode, Expand, Quit, Undo, Retry, Copy key.Binding
	// Reading.
	PageUp, PageDown, LineUp, LineDown, Top, Bottom key.Binding
}

var actions = []action{
	{"start", "start menu", "Apps", []string{"ctrl+space", "ctrl+p"}, false, func(k *keyMap) *key.Binding { return &k.Start }},
	{"chat", "chat", "Apps", []string{"f1"}, false, func(k *keyMap) *key.Binding { return &k.Chat }},
	{"files", "files", "Apps", []string{"f2"}, false, func(k *keyMap) *key.Binding { return &k.Files }},
	{"search", "search", "Apps", []string{"f3", "ctrl+f"}, false, func(k *keyMap) *key.Binding { return &k.Search }},
	{"sessions", "sessions", "Apps", []string{"f4"}, false, func(k *keyMap) *key.Binding { return &k.Sessions }},
	{"models", "models", "Apps", []string{"f5"}, false, func(k *keyMap) *key.Binding { return &k.Models }},
	{"themes", "themes", "Apps", []string{"f6", "ctrl+t"}, false, func(k *keyMap) *key.Binding { return &k.Themes }},
	{"keys", "keys", "Apps", []string{"f7"}, false, func(k *keyMap) *key.Binding { return &k.Keys }},
	{"help", "help", "Apps", []string{"f8", "?"}, false, func(k *keyMap) *key.Binding { return &k.Help }},
	{"stats", "stats", "Apps", []string{"f9"}, false, func(k *keyMap) *key.Binding { return &k.Stats }},
	{"changes", "changes", "Apps", []string{"f10"}, false, func(k *keyMap) *key.Binding { return &k.Changes }},
	{"gallery", "gallery", "Apps", []string{"f12"}, false, func(k *keyMap) *key.Binding { return &k.Gallery }},

	{"tasks", "tasks", "Apps", []string{"alt+t"}, false, func(k *keyMap) *key.Binding { return &k.Tasks }},
	{"notifications", "notifications", "Apps", []string{"alt+n"}, false, func(k *keyMap) *key.Binding { return &k.Notifications }},

	{"providers", "providers", "Apps", []string{"alt+p"}, false, func(k *keyMap) *key.Binding { return &k.Providers }},
	{"settings", "settings", "Apps", []string{"alt+s"}, false, func(k *keyMap) *key.Binding { return &k.Settings }},

	{"next-window", "next window", "Windows", []string{"ctrl+pgdown", "alt+]"}, false, func(k *keyMap) *key.Binding { return &k.NextWindow }},
	{"prev-window", "previous window", "Windows", []string{"ctrl+pgup", "alt+["}, false, func(k *keyMap) *key.Binding { return &k.PrevWindow }},
	{"close-window", "close window", "Windows", []string{"ctrl+w"}, false, func(k *keyMap) *key.Binding { return &k.CloseWindow }},

	{"mode", "mode", "Session", []string{"shift+tab"}, false, func(k *keyMap) *key.Binding { return &k.Mode }},
	{"expand", "expand output", "Session", []string{"ctrl+o"}, false, func(k *keyMap) *key.Binding { return &k.Expand }},
	{"undo", "undo last turn", "Session", []string{"alt+z"}, false, func(k *keyMap) *key.Binding { return &k.Undo }},
	{"retry", "send again", "Session", []string{"alt+r"}, false, func(k *keyMap) *key.Binding { return &k.Retry }},
	{"copy", "copy last reply", "Session", []string{"alt+y"}, false, func(k *keyMap) *key.Binding { return &k.Copy }},
	{"quit", "quit", "Session", []string{"ctrl+d"}, false, func(k *keyMap) *key.Binding { return &k.Quit }},

	{"page-up", "page up", "Reading", []string{"pgup"}, false, func(k *keyMap) *key.Binding { return &k.PageUp }},
	{"page-down", "page down", "Reading", []string{"pgdown"}, false, func(k *keyMap) *key.Binding { return &k.PageDown }},
	{"line-up", "line up", "Reading", []string{"alt+up"}, false, func(k *keyMap) *key.Binding { return &k.LineUp }},
	{"line-down", "line down", "Reading", []string{"alt+down"}, false, func(k *keyMap) *key.Binding { return &k.LineDown }},
	{"top", "top", "Reading", []string{"ctrl+home"}, false, func(k *keyMap) *key.Binding { return &k.Top }},
	{"bottom", "bottom", "Reading", []string{"ctrl+end"}, false, func(k *keyMap) *key.Binding { return &k.Bottom }},

	{"send", "send", "Typing", []string{"enter"}, true, func(k *keyMap) *key.Binding { return &k.Send }},
	{"newline", "new line", "Typing", []string{"shift+enter", "alt+enter", "ctrl+j"}, true, func(k *keyMap) *key.Binding { return &k.Newline }},
	{"complete", "complete", "Typing", []string{"tab"}, true, func(k *keyMap) *key.Binding { return &k.Complete }},
	{"history", "earlier messages", "Typing", []string{"up", "down"}, true, func(k *keyMap) *key.Binding { return &k.History }},
	{"cancel", "stop · close · live", "Typing", []string{"esc"}, true, func(k *keyMap) *key.Binding { return &k.Cancel }},
	{"interrupt", "stop · clear · quit", "Typing", []string{"ctrl+c"}, true, func(k *keyMap) *key.Binding { return &k.Interrupt }},
}

// actionGroups in the order the Keys app and help show them.
var actionGroups = []string{"Apps", "Windows", "Session", "Reading", "Typing"}

func findAction(id string) (action, bool) {
	for _, a := range actions {
		if a.id == id {
			return a, true
		}
	}
	return action{}, false
}

// newKeyMap builds the bindings: each action's defaults, or what overrides says for it. Overrides
// for locked actions, unknown ids, or with no keys are ignored.
func newKeyMap(overrides map[string][]string) keyMap {
	var k keyMap
	for _, a := range actions {
		keys := a.defaults
		if o := overrides[a.id]; len(o) > 0 && !a.locked {
			keys = o
		}
		*a.field(&k) = key.NewBinding(key.WithKeys(keys...), key.WithHelp(keyLabel(keys), a.label))
	}
	return k
}

// keysFor is the keys an action is bound to in this map.
func (k *keyMap) keysFor(a action) []string { return a.field(k).Keys() }

// conflict is the action, other than id, that already uses key; empty when none does.
func (k *keyMap) conflict(id, key string) string {
	for _, a := range actions {
		if a.id == id {
			continue
		}
		for _, used := range k.keysFor(a) {
			if used == key {
				return a.id
			}
		}
	}
	return ""
}

// keyLabel is how a set of keys is shown: the first, made readable ("alt+↑", "pgdn", "F2").
func keyLabel(keys []string) string {
	if len(keys) == 0 {
		return ""
	}
	if len(keys) == 2 && keys[0] == "up" && keys[1] == "down" {
		return "↑/↓"
	}
	return prettyKey(keys[0])
}

func prettyKey(k string) string {
	names := map[string]string{"up": "↑", "down": "↓", "left": "←", "right": "→", "pgdown": "pgdn"}
	parts := strings.Split(k, "+")
	last := parts[len(parts)-1]
	switch {
	case len(last) >= 2 && last[0] == 'f' && last[1] >= '0' && last[1] <= '9':
		parts[len(parts)-1] = strings.ToUpper(last)
	case names[last] != "":
		parts[len(parts)-1] = names[last]
	}
	return strings.Join(parts, "+")
}

// shortFor is the dock's hint for what the screen is doing now: only keys that do something.
func (k keyMap) shortFor(m *Model) []key.Binding {
	switch {
	case m.phase == busy:
		return []key.Binding{withHelp(k.Cancel, "esc", "stop"), k.Expand}
	case !m.tr.following():
		return []key.Binding{withHelp(k.Cancel, "esc", "back to live"), k.PageUp, k.PageDown}
	default:
		return []key.Binding{k.Mode, k.Start}
	}
}

func withHelp(b key.Binding, keys, desc string) key.Binding {
	b.SetHelp(keys, desc)
	return b
}

// fullHelp is the help overlay's columns, by group.
func (k keyMap) fullHelp() [][]key.Binding {
	var columns [][]key.Binding
	for _, group := range actionGroups {
		var column []key.Binding
		for _, a := range actions {
			if a.group == group {
				column = append(column, *a.field(&k))
			}
		}
		columns = append(columns, column)
	}
	return columns
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
