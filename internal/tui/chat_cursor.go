package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// The conversation, by keyboard. ↑ on an empty input steps up into the transcript: a bar in the
// margin marks the message or tool call the keyboard is on, ↑/↓ move from one to the next (the view
// follows), enter opens it (a tool call's whole output, or a message in a reader) and space reads it
// in a reader. ↓ past the newest, esc or typing goes back to the input. Earlier messages, which ↑
// recalled before, are ctrl+↑ and ctrl+↓. A click selects a block; a second click opens it.

// selectable is an item the keyboard can stop on: what the person said, what the agent said, and
// each tool call.
func selectable(it item) bool {
	switch it.(type) {
	case *userItem, *assistantItem, *toolItem:
		return true
	}
	return false
}

// stepItem is the selectable item dir (±1) from the selected one, or -1 when there is none.
func (m *Model) stepItem(dir int) int {
	at := len(m.tr.items)
	for i, it := range m.tr.items {
		if it == m.tr.sel {
			at = i
		}
	}
	for i := at + dir; i >= 0 && i < len(m.tr.items); i += dir {
		if selectable(m.tr.items[i]) {
			return i
		}
	}
	return -1
}

// enterTranscript puts the keyboard on the newest block; false when there is none to stand on.
func (m *Model) enterTranscript() bool {
	i := m.stepItem(-1)
	if i < 0 {
		return false
	}
	m.selectItem(m.tr.items[i])
	return true
}

func (m *Model) selectItem(it item) {
	m.tr.sel = it
	m.scrollToItem(it)
}

// transcriptKey handles a key while the keyboard is in the transcript; false hands it to the input.
func (m *Model) transcriptKey(msg tea.KeyPressMsg) (tea.Cmd, bool) {
	switch msg.String() {
	case "up":
		if i := m.stepItem(-1); i >= 0 {
			m.selectItem(m.tr.items[i])
		}
	case "down":
		if i := m.stepItem(1); i >= 0 {
			m.selectItem(m.tr.items[i])
		} else {
			m.tr.sel = nil // past the newest: back to the input, and to live output
			return m.scrollTo(0), true
		}
	case "home":
		m.tr.sel = nil
		if m.enterFirst() {
			return nil, true
		}
	case "end":
		m.tr.sel = nil
		m.enterTranscript()
	case "enter":
		return m.openItem(m.tr.sel), true
	case "space":
		return m.readItem(m.tr.sel), true
	case "esc":
		m.tr.sel = nil
		return m.scrollTo(0), true
	default:
		m.tr.sel = nil // anything else is typing, or a key of the input's
		return nil, false
	}
	return nil, true
}

// enterFirst selects the oldest block.
func (m *Model) enterFirst() bool {
	for _, it := range m.tr.items {
		if selectable(it) {
			m.selectItem(it)
			return true
		}
	}
	return false
}

// openItem is enter on a block: a tool call shows its whole output (again: folds it), a message
// opens in a reader.
func (m *Model) openItem(it item) tea.Cmd {
	if t, ok := it.(*toolItem); ok {
		t.open = !t.open
		t.touch()
		m.scrollToItem(t)
		return nil
	}
	return m.readItem(it)
}

// readItem opens a block in a reader: all of it, searchable, copyable.
func (m *Model) readItem(it item) tea.Cmd {
	var label, text string
	switch v := it.(type) {
	case *userItem:
		label, text = "your message", v.text
	case *assistantItem:
		label, text = "reply", v.text.String()
	case *toolItem:
		label = v.name
		text = strings.TrimSpace(fmt.Sprintf("%s %s\n\n%s", v.name, toolBrief(v), v.result))
	default:
		return nil
	}
	m.openWindow(newPager(m, label, strings.Split(strings.TrimRight(text, "\n"), "\n")))
	return nil
}

// scrollToItem scrolls the transcript just enough to show it, its top first when it is taller than
// the view.
func (m *Model) scrollToItem(target item) {
	ctx := renderCtx{th: m.th, md: m.md, width: max(m.width-2, 10), expanded: m.expanded, root: m.projectRoot(), zones: m.zones.frame}
	below := 0 // lines under the target's last line, to the newest
	height := 0
	for i := len(m.tr.items) - 1; i >= 0; i-- {
		n := len(m.tr.lines(m.tr.items[i], ctx))
		if n == 0 {
			continue
		}
		if m.tr.items[i] == target {
			height = n
			break
		}
		below += n + 1
	}
	view := max(m.transcriptHeight()-2, 1)
	scroll := m.tr.scroll
	switch {
	case below < scroll:
		scroll = below
	case below+height > scroll+view:
		scroll = below + height - view
	}
	m.stopScroll()
	m.tr.scroll = max(scroll, 0)
}

// itemClick is a click on a block of the transcript: the first selects it, a second opens it.
func (m *Model) itemClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	for _, it := range m.tr.items {
		if !selectable(it) || !m.zones.frame.Get(itemZone(it)).InBounds(msg) {
			continue
		}
		if m.tr.sel == it {
			return m.openItem(it), true
		}
		m.tr.sel = it
		return nil, true
	}
	return nil, false
}

// itemZone is a block's click target.
func itemZone(it item) string { return fmt.Sprintf("item:%p", it) }

// cursorMargin is the transcript's left margin on row i: the focus bar beside the selected block.
func (m *Model) cursorMargin(i int) string {
	if m.tr.selRows[i] {
		return lipgloss.NewStyle().Foreground(m.th.BorderFocus).Render("▌")
	}
	return " "
}
