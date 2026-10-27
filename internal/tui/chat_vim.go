package tui

import (
	"strings"
	"unicode"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/config"
)

// Vim keys for the input, off unless asked for (/vim, ARCHYMEDES_VIM=on). esc on a non-empty input
// enters normal mode; i, a, o and the rest go back to typing. enter sends in either mode, and esc in
// normal mode keeps its ordinary meaning (stop the turn, step out to the bars), so nothing that
// works without vim stops working with it.

// vimState is the input's vim mode.
type vimState struct {
	on     bool
	normal bool
	// pending is an operator or prefix waiting for its motion: d, c, y, g.
	pending string
	// register is the last yanked or deleted text; linewise when it ends in a newline.
	register string
	undo     []vimSnapshot
}

type vimSnapshot struct {
	text   []rune
	cursor int
}

// vimEdit applies one normal-mode key to text at cursor. It returns the new text and cursor, and
// whether the key goes back to typing (i, a, o, c…). Keys it does not know change nothing.
func (v *vimState) vimEdit(text []rune, cursor int, key string) ([]rune, int, bool) {
	cursor = clampCursor(text, cursor)
	save := func() {
		v.undo = append(v.undo, vimSnapshot{append([]rune(nil), text...), cursor})
		if len(v.undo) > 100 {
			v.undo = v.undo[1:]
		}
	}
	if v.pending != "" {
		op := v.pending
		v.pending = ""
		switch {
		case op == "g" && key == "g":
			return text, 0, false
		case (op == "d" || op == "c" || op == "y") && key == op: // dd, cc, yy: the whole line
			start, end := lineStart(text, cursor), lineEnd(text, cursor)
			if op == "y" {
				v.register = string(text[start:end]) + "\n"
				return text, cursor, false
			}
			save()
			if op == "c" {
				v.register = string(text[start:end]) + "\n"
				return append(append([]rune(nil), text[:start]...), text[end:]...), start, true
			}
			cut := end
			if cut < len(text) {
				cut++ // the newline goes with the line
			} else if start > 0 {
				start-- // the last line takes the newline before it
			}
			v.register = string(text[lineStart(text, cursor):lineEnd(text, cursor)]) + "\n"
			out := append(append([]rune(nil), text[:start]...), text[cut:]...)
			return out, clampCursor(out, lineStart(out, min(start, len(out)))), false
		case op == "d" || op == "c" || op == "y":
			to, ok := motion(text, cursor, key)
			if !ok {
				return text, cursor, false
			}
			if op == "c" && key == "w" { // cw changes to the end of the word, as vim does
				to = wordEnd(text, cursor) + 1
			}
			from, upto := min(cursor, to), max(cursor, to)
			if key == "e" || key == "$" {
				upto = min(upto+1, len(text))
				if key == "$" {
					upto = lineEnd(text, cursor)
				}
			}
			v.register = string(text[from:upto])
			if op == "y" {
				return text, cursor, false
			}
			save()
			out := append(append([]rune(nil), text[:from]...), text[upto:]...)
			return out, clampCursor(out, from), op == "c"
		}
		return text, cursor, false
	}
	switch key {
	case "i":
		return text, cursor, true
	case "a":
		if cursor < lineEnd(text, cursor) {
			cursor++
		}
		return text, cursor, true
	case "I":
		return text, firstNonBlank(text, cursor), true
	case "A":
		return text, lineEnd(text, cursor), true
	case "o", "O":
		save()
		at := lineEnd(text, cursor)
		if key == "O" {
			at = lineStart(text, cursor)
		}
		out := append(append(append([]rune(nil), text[:at]...), '\n'), text[at:]...)
		if key == "o" {
			return out, at + 1, true
		}
		return out, at, true
	case "x":
		if cursor < lineEnd(text, cursor) {
			save()
			v.register = string(text[cursor])
			out := append(append([]rune(nil), text[:cursor]...), text[cursor+1:]...)
			if cursor == lineEnd(out, cursor) && cursor > lineStart(out, cursor) {
				cursor-- // the last character went: stay on the line's new last one
			}
			return out, cursor, false
		}
		return text, cursor, false
	case "X":
		if cursor > lineStart(text, cursor) {
			save()
			out := append(append([]rune(nil), text[:cursor-1]...), text[cursor:]...)
			return out, cursor - 1, false
		}
		return text, cursor, false
	case "D", "C":
		save()
		end := lineEnd(text, cursor)
		v.register = string(text[cursor:end])
		out := append(append([]rune(nil), text[:cursor]...), text[end:]...)
		return out, cursor, key == "C"
	case "d", "c", "y", "g":
		v.pending = key
		return text, cursor, false
	case "p", "P":
		if v.register == "" {
			return text, cursor, false
		}
		save()
		reg := []rune(v.register)
		if strings.HasSuffix(v.register, "\n") { // linewise: below or above this line
			at := lineStart(text, cursor)
			if key == "p" {
				at = lineEnd(text, cursor)
				reg = append([]rune{'\n'}, reg[:len(reg)-1]...)
				out := append(append(append([]rune(nil), text[:at]...), reg...), text[at:]...)
				return out, at + 1, false
			}
			out := append(append(append([]rune(nil), text[:at]...), reg...), text[at:]...)
			return out, at, false
		}
		at := cursor
		if key == "p" && cursor < len(text) && text[cursor] != '\n' {
			at++
		}
		out := append(append(append([]rune(nil), text[:at]...), reg...), text[at:]...)
		return out, at + len(reg) - 1, false
	case "u":
		if n := len(v.undo); n > 0 {
			s := v.undo[n-1]
			v.undo = v.undo[:n-1]
			return s.text, s.cursor, false
		}
		return text, cursor, false
	}
	if to, ok := motion(text, cursor, key); ok {
		return text, clampCursor(text, to), false
	}
	return text, cursor, false
}

// motion is where a motion key moves the cursor.
func motion(text []rune, cursor int, key string) (int, bool) {
	switch key {
	case "h":
		return max(cursor-1, lineStart(text, cursor)), true
	case "l":
		return min(cursor+1, max(lineEnd(text, cursor)-1, lineStart(text, cursor))), true
	case "0":
		return lineStart(text, cursor), true
	case "^":
		return firstNonBlank(text, cursor), true
	case "$":
		return max(lineEnd(text, cursor)-1, lineStart(text, cursor)), true
	case "w":
		i := cursor
		for i < len(text) && !unicode.IsSpace(text[i]) {
			i++
		}
		for i < len(text) && unicode.IsSpace(text[i]) {
			i++
		}
		return i, true
	case "b":
		i := cursor
		for i > 0 && unicode.IsSpace(text[i-1]) {
			i--
		}
		for i > 0 && !unicode.IsSpace(text[i-1]) {
			i--
		}
		return i, true
	case "e":
		return wordEnd(text, cursor), true
	case "j", "k":
		start := lineStart(text, cursor)
		col := cursor - start
		if key == "k" {
			if start == 0 {
				return cursor, true
			}
			prev := lineStart(text, start-1)
			return min(prev+col, start-1), true
		}
		end := lineEnd(text, cursor)
		if end >= len(text) {
			return cursor, true
		}
		next := end + 1
		return min(next+col, lineEnd(text, next)), true
	case "G":
		return lineStart(text, len(text)), true
	}
	return cursor, false
}

func wordEnd(text []rune, cursor int) int {
	i := cursor + 1
	for i < len(text) && unicode.IsSpace(text[i]) {
		i++
	}
	for i+1 < len(text) && !unicode.IsSpace(text[i+1]) {
		i++
	}
	return min(i, max(len(text)-1, 0))
}

func lineStart(text []rune, cursor int) int {
	for i := min(cursor, len(text)) - 1; i >= 0; i-- {
		if text[i] == '\n' {
			return i + 1
		}
	}
	return 0
}

func lineEnd(text []rune, cursor int) int {
	for i := cursor; i < len(text); i++ {
		if text[i] == '\n' {
			return i
		}
	}
	return len(text)
}

func firstNonBlank(text []rune, cursor int) int {
	i := lineStart(text, cursor)
	end := lineEnd(text, cursor)
	for i < end && (text[i] == ' ' || text[i] == '\t') {
		i++
	}
	return i
}

func clampCursor(text []rune, cursor int) int { return max(0, min(cursor, len(text))) }

// vimOn reads ARCHYMEDES_VIM.
func vimOn(configDir string) bool {
	return strings.EqualFold(strings.TrimSpace(config.Setting(configDir, "ARCHYMEDES_VIM")), "on")
}

// vimKey is the input's key in vim terms, when vim is on: (cmd, true) when it took the key.
func (m *Model) vimKey(msg tea.KeyPressMsg) (tea.Cmd, bool) {
	v := &m.vim
	key := msg.String()
	if !v.normal {
		if key == "esc" && m.input.value() != "" && len(m.input.complete) == 0 {
			v.normal, v.pending = true, ""
			text, cursor := m.input.runes()
			m.input.setRunes(text, max(cursor-1, lineStart(text, cursor)))
			return nil, true
		}
		return nil, false
	}
	// enter, esc and control keys keep their meaning; so does anything longer than one character.
	if key == "enter" || key == "esc" || len([]rune(key)) != 1 {
		if key == "enter" {
			v.normal = false
		}
		return nil, false
	}
	text, cursor := m.input.runes()
	out, at, insert := v.vimEdit(text, cursor, key)
	m.input.setRunes(out, at)
	v.normal = !insert
	return nil, true
}

// cmdVim is /vim: vim keys on or off, kept for the next start.
func (m *Model) cmdVim(string) tea.Cmd {
	m.vim = vimState{on: !m.vim.on}
	word, text := "off", "Vim keys off"
	if m.vim.on {
		word, text = "on", "Vim keys on: esc for normal mode, i to type again, enter sends"
	}
	return tea.Batch(m.toast(toastInfo, text), m.saveSettingLater("ARCHYMEDES_VIM", word))
}
