package tui

import (
	"fmt"

	tea "charm.land/bubbletea/v2"
)

// Clicks, resolved against BubbleZone zones (zones.go): the toasts' manager first (they float on
// top), then the open dialog's, then the frame's — start button, tabs, dock, tool cards, and
// whatever the focused window marks (the Stats app's bars).

// rowPicker is a dialog whose rows are click targets, marked "row:<index>".
type rowPicker interface {
	rowCount() int
	choose(m *Model, index int) tea.Cmd
}

// windowClicker is a window with click targets of its own.
type windowClicker interface {
	click(m *Model, msg tea.MouseClickMsg) tea.Cmd
}

func rowID(i int) string { return fmt.Sprintf("row:%d", i) }

func (m *Model) handleClick(msg tea.MouseClickMsg) tea.Cmd {
	if msg.Mouse().Button != tea.MouseLeft || m.approval != nil {
		return nil // an approval is answered with keys, never by a stray click
	}
	for _, t := range m.toasts {
		if m.zones.toasts.Get(fmt.Sprintf("toast:%d", t.id)).InBounds(msg) {
			m.expireToast(t.id)
			return nil
		}
	}
	if m.overlay != nil {
		if !m.zones.dialog.Get("dialog").InBounds(msg) {
			m.overlay = nil // a click outside a dialog closes it, as esc does
			return nil
		}
		if p, ok := m.overlay.(rowPicker); ok {
			for i := range p.rowCount() {
				if m.zones.dialog.Get(rowID(i)).InBounds(msg) {
					return p.choose(m, i)
				}
			}
		}
		return nil
	}
	frame := m.zones.frame
	if frame.Get("start").InBounds(msg) {
		return m.runAction("start")
	}
	for i := 0; i <= len(m.windows); i++ {
		if frame.Get(fmt.Sprintf("tab:%d", i)).InBounds(msg) {
			m.focus(i)
			return nil
		}
	}
	for _, app := range dockApps {
		if frame.Get("app:" + app.id).InBounds(msg) {
			return m.runAction(app.id)
		}
	}
	if w := m.activeWindow(); w != nil {
		if c, ok := w.(windowClicker); ok {
			return c.click(m, msg)
		}
		return nil
	}
	for _, it := range m.tr.items {
		if t, ok := it.(*toolItem); ok && t.done && frame.Get("tool:"+t.id).InBounds(msg) {
			t.open = !t.open
			t.touch()
			return nil
		}
	}
	return nil
}

// --- the pickers' rows ---

func (p *startMenu) rowCount() int { return len(p.shown) }
func (p *startMenu) choose(m *Model, i int) tea.Cmd {
	p.cursor = i
	_, cmd := p.handle(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	return cmd
}

func (p *modelPicker) rowCount() int { return len(p.shown) }
func (p *modelPicker) choose(m *Model, i int) tea.Cmd {
	if p.pending {
		return nil
	}
	p.cursor = i
	_, cmd := p.handle(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	return cmd
}

func (p *resumePicker) rowCount() int { return len(p.shown) }
func (p *resumePicker) choose(m *Model, i int) tea.Cmd {
	p.cursor = i
	closed, cmd := p.handle(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	if closed && m.overlay == p {
		m.overlay = nil
	}
	return cmd
}

func (t *themePicker) rowCount() int { return len(t.names) }
func (t *themePicker) choose(m *Model, i int) tea.Cmd {
	t.cursor = i
	m.applyTheme(t.names[i])
	m.overlay = nil
	return m.toast(toastInfo, "Theme: "+t.names[i])
}
