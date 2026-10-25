package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/config"
)

// The Keys app: every action, its key, and a way to change it without editing a file. Enter on a
// row, press the new key, done — it applies at once everywhere (dispatch, dock, help, start menu)
// and is saved to keys.json. A key another action uses is named and refused; r resets a row, R all.

type keysApp struct {
	rows    []keyRow // each group's name, then its actions
	list    listView
	waiting bool // the next key pressed becomes the binding
	note    string
	bad     bool
}

// keyRow is a row of the list: a group's name, or an action in it.
type keyRow struct {
	group  string
	action action
}

func newKeysApp(m *Model) *keysApp {
	k := &keysApp{list: listView{zone: "key"}}
	for _, group := range actionGroups {
		k.rows = append(k.rows, keyRow{group: group})
		for _, a := range actions {
			if a.group == group {
				k.rows = append(k.rows, keyRow{action: a})
			}
		}
	}
	k.list.skip = func(i int) bool { return k.rows[i].group != "" }
	k.list.move("home", len(k.rows))
	return k
}

func (k *keysApp) title() string    { return "Keys" }
func (k *keysApp) key() string      { return "keys" }
func (k *keysApp) capturing() bool  { return k.waiting }
func (k *keysApp) selected() action { return k.rows[k.list.cursor].action }

func (k *keysApp) wheel(_ *Model, up bool) tea.Cmd {
	k.list.wheel(up, len(k.rows))
	return nil
}

// click selects an action; a second click on it waits for its new key, as enter does.
func (k *keysApp) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	if i, ok := k.list.clicked(m.zones.frame, msg, len(k.rows)); ok && k.list.clickRow(i) {
		_, cmd := k.handle(m, keyPress("enter"))
		return cmd
	}
	return nil
}

func (k *keysApp) say(text string, bad bool) { k.note, k.bad = text, bad }

func (k *keysApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	pressed := msg.String()
	if k.waiting {
		k.waiting = false
		if pressed == "esc" {
			k.say("Unchanged.", false)
			return false, nil
		}
		k.bind(m, k.selected(), pressed)
		return false, nil
	}
	switch pressed {
	case "esc", "q":
		return true, nil
	case "enter", "space":
		if a := k.selected(); a.locked {
			k.say(a.label+" is fixed: typing depends on it.", true)
		} else {
			k.waiting = true
			k.say("Press the new key for “"+a.label+"” — esc keeps the old one.", false)
		}
	case "r":
		a := k.selected()
		if _, changed := m.keyOverrides[a.id]; !changed {
			k.say(a.label+" already has its default key.", false)
			return false, nil
		}
		delete(m.keyOverrides, a.id)
		k.apply(m, a.label+" is back to "+keyLabel(a.defaults)+".")
	case "R":
		if len(m.keyOverrides) == 0 {
			k.say("Every key is already its default.", false)
			return false, nil
		}
		m.keyOverrides = map[string][]string{}
		k.apply(m, "Every key is back to its default.")
	default:
		k.list.move(pressed, len(k.rows))
	}
	return false, nil
}

// bind makes pressed the key for a, unless it would get in the way of typing or of another action.
func (k *keysApp) bind(m *Model, a action, pressed string) {
	if !shortcutKey(pressed) {
		k.say(prettyKey(pressed)+" types text, so it cannot be a shortcut: use ctrl, alt, or a key like F2.", true)
		return
	}
	if other := m.keys.conflict(a.id, pressed); other != "" {
		taken, _ := findAction(other)
		k.say(prettyKey(pressed)+" already means “"+taken.label+"”. Change that one first, or pick another key.", true)
		return
	}
	m.keyOverrides[a.id] = []string{pressed}
	k.apply(m, a.label+" is now "+prettyKey(pressed)+".")
}

// apply rebuilds the bindings from the overrides and saves them; everything reads the new map at once.
func (k *keysApp) apply(m *Model, done string) {
	m.keys = newKeyMap(m.keyOverrides)
	if m.opts.ConfigDir == "" {
		k.say(done+" (for this session)", false)
		return
	}
	if err := config.SaveKeys(m.opts.ConfigDir, m.keyOverrides); err != nil {
		k.say(done+" Not saved: "+err.Error(), true)
		return
	}
	k.say(done+" Saved.", false)
}

// shortcutKey is a key that can be a shortcut without stealing typing: one with ctrl or alt, or a
// named key (F1–F12, pgup, home…). A plain letter, digit, symbol or shift+letter types text.
func shortcutKey(k string) bool {
	if strings.Contains(k, "ctrl+") || strings.Contains(k, "alt+") {
		return true
	}
	base := k[strings.LastIndex(k, "+")+1:]
	if len(base) >= 2 && base[0] == 'f' && base[1] >= '0' && base[1] <= '9' {
		return true
	}
	switch base {
	case "pgup", "pgdown", "home", "end", "insert", "delete":
		return true
	}
	return false
}

func (k *keysApp) view(m *Model) string {
	th := m.th
	height := max(m.windowHeight(), 1)
	width := m.width
	// The key column takes what the label and the state tag leave, so narrow windows fit.
	labelWidth := min(22, max(width/3, 8))
	keyWidth := min(24, max(width-labelWidth-4-1-1-8, 6))
	from, to := k.list.window(len(k.rows), max(height-2, 1))
	var lines []string
	for i := from; i < to; i++ {
		r := k.rows[i]
		if r.group != "" {
			lines = append(lines, "  "+th.Strong.Render(r.group))
			continue
		}
		a := r.action
		keys := keyLabel(m.keys.keysFor(a))
		if extra := m.keys.keysFor(a); len(extra) > 1 && keys != "↑/↓" {
			keys += th.Faint.Render(" · " + prettyKey(extra[1]))
		}
		if i == k.list.cursor && k.waiting {
			keys = "press a key…"
		}
		state := ""
		switch {
		case a.locked:
			state = th.Faint.Render("fixed")
		case len(m.keyOverrides[a.id]) > 0:
			state = th.Highlight.Render("changed")
		}
		label := padRight(ansi.Truncate(a.label, labelWidth, "…"), labelWidth)
		cell := padRight(ansi.Truncate(keys, keyWidth, "…"), keyWidth)
		lines = append(lines, k.list.row(m, m.zones.frame, i, "    "+label+" "+th.Key.Render(cell)+" "+state, width))
	}
	for len(lines) < height-2 {
		lines = append(lines, "")
	}
	note := th.Faint.Render(fmt.Sprintf("%d actions · changes apply at once and are saved", len(actions)))
	if k.note != "" {
		note = th.Body.Render(k.note)
		if k.bad {
			note = th.Warn.Render(k.note)
		}
	}
	lines = append(lines, " "+ansi.Truncate(note, max(width-2, 0), "…"),
		m.hintBar(width, button{"enter", "change"}, button{"r", "reset"}, button{"R", "reset all"}, button{"q", "close"}))
	return strings.Join(fitLines(lines, width, height), "\n")
}
