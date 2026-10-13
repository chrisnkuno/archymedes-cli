package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/config"
)

// The Keys app: every action, its key, and a way to change it without editing a file. Enter on a
// row, press the new key, done — it applies at once everywhere (dispatch, dock, help, start menu)
// and is saved to keys.json. A key another action uses is named and refused; r resets a row, R all.

type keysApp struct {
	rows    []action // every action, grouped
	cursor  int
	waiting bool // the next key pressed becomes the binding
	note    string
	bad     bool
}

func newKeysApp(m *Model) *keysApp {
	k := &keysApp{}
	for _, group := range actionGroups {
		for _, a := range actions {
			if a.group == group {
				k.rows = append(k.rows, a)
			}
		}
	}
	return k
}

func (k *keysApp) title() string    { return "Keys" }
func (k *keysApp) key() string      { return "keys" }
func (k *keysApp) capturing() bool  { return k.waiting }
func (k *keysApp) selected() action { return k.rows[k.cursor] }

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
	case "up", "k":
		k.cursor = (k.cursor - 1 + len(k.rows)) % len(k.rows)
	case "down", "j":
		k.cursor = (k.cursor + 1) % len(k.rows)
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
	header := " " + th.Title.Render("Keys") + th.Faint.Render("  enter change · r reset · R reset all · esc close")
	lines := []string{ansi.Truncate(header, width, ""), ""}

	// The key column takes what the label and the state tag leave, so narrow windows fit.
	labelWidth := min(22, max(width/3, 8))
	keyWidth := min(24, max(width-labelWidth-4-1-1-8, 6))
	group := ""
	var body []string
	selectedRow := 0
	for i, a := range k.rows {
		if a.group != group {
			group = a.group
			if len(body) > 0 {
				body = append(body, "")
			}
			body = append(body, "  "+th.Strong.Render(group))
		}
		keys := keyLabel(m.keys.keysFor(a))
		if extra := m.keys.keysFor(a); len(extra) > 1 && keys != "↑/↓" {
			keys += th.Faint.Render(" · " + prettyKey(extra[1]))
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
		row := "    " + label + " " + th.Key.Render(cell) + " " + state
		if i == k.cursor {
			selectedRow = len(body)
			mark := "  › "
			if k.waiting {
				cell = padRight("press a key…", keyWidth)
			}
			row = lipgloss.NewStyle().Foreground(th.Text).Background(th.Tint(th.Primary, 0.3)).Bold(true).
				Render(ansi.Truncate(padRight(mark+label+" "+cell+" "+ansi.Strip(state), width-2), width-2, ""))
		}
		body = append(body, ansi.Truncate(row, width, "…"))
	}

	room := max(height-len(lines)-2, 1)
	start := max(0, min(selectedRow-room/2, len(body)-room))
	end := min(start+room, len(body))
	lines = append(lines, body[start:end]...)
	for len(lines) < height-1 {
		lines = append(lines, "")
	}
	note := th.Faint.Render(fmt.Sprintf("%d actions · changes apply at once and are saved", len(k.rows)))
	if k.note != "" {
		note = th.Body.Render(k.note)
		if k.bad {
			note = th.Warn.Render(k.note)
		}
	}
	lines = append(lines, " "+ansi.Truncate(note, max(width-2, 0), "…"))
	return strings.Join(lines[:height], "\n")
}
