package tui

import (
	"cmp"
	"fmt"
	"github.com/chrisnkuno/friday-cli/internal/gallery"
	"slices"

	tea "charm.land/bubbletea/v2"
)

// Clicks, resolved against BubbleZone zones (core_zones.go): the toasts' manager first (they float on
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
		if _, walkthrough := m.overlay.(*onboarding); walkthrough && !m.zones.dialog.Get("dialog").InBounds(msg) {
			return nil // a stray click does not end the first-run walkthrough; esc does
		}
		if !m.zones.dialog.Get("dialog").InBounds(msg) {
			m.overlay = nil // a click outside a dialog closes it, as esc does
			return nil
		}
		if cmd, ok := m.dialogButtonClick(msg); ok {
			return cmd
		}
		if c, ok := m.overlay.(interface {
			click(*Model, tea.MouseClickMsg) tea.Cmd
		}); ok {
			return c.click(m, msg)
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
	if m.activeWindow() == nil {
		if cmd, ok := m.composerClick(msg); ok {
			return cmd
		}
	}
	if m.activeWindow() == nil && frame.Get("composer").InBounds(msg) {
		x, y := frame.Get("composer").Pos(msg)
		m.input.placeCursor(x, y)
		return nil
	}
	if frame.Get("mode").InBounds(msg) {
		return m.setMode(nextMode(cmp.Or(m.pendingMode, m.mode)))
	}
	if frame.Get("notes").InBounds(msg) {
		return m.runAction("notifications")
	}
	if frame.Get("changes-chip").InBounds(msg) {
		return m.runAction("changes")
	}
	if frame.Get("start").InBounds(msg) {
		return m.runAction("start")
	}
	for i := 0; i <= len(m.windows); i++ {
		if frame.Get(fmt.Sprintf("tab:%d", i)).InBounds(msg) {
			m.focus(i)
			return nil
		}
	}
	for _, app := range append(slices.Clone(dockApps), systemApps...) {
		if frame.Get("app:" + app.id).InBounds(msg) {
			return m.runAction(app.id)
		}
	}
	if w := m.activeWindow(); w != nil {
		if cmd, ok := m.windowChromeClick(msg); ok {
			return cmd
		}
		if cmd, ok := m.buttonClick(msg); ok {
			return cmd
		}
		var cmd tea.Cmd
		if c, ok := w.(windowClicker); ok {
			m.within(func() { cmd = c.click(m, msg) })
		}
		return cmd
	}
	if m.landingVisible() {
		if cmd, ok := m.deskClick(msg); ok {
			return cmd
		}
		for i := range m.starters() {
			if frame.Get(fmt.Sprintf("starter:%d", i)).InBounds(msg) {
				m.useStarter(i)
				return nil
			}
		}
	}
	for i, s := range m.shownSteps() {
		if frame.Get(fmt.Sprintf("step:%d", i)).InBounds(msg) {
			m.input.take()
			m.input.area.InsertString(s.Text)
			return nil
		}
	}
	if m.landingVisible() {
		if cmd, ok := m.tourClick(msg); ok {
			return cmd
		}
	}
	if m.landingVisible() && frame.Get("photo").InBounds(msg) {
		return m.openGallery(gallery.IndexOf(m.homePhoto())) // the photo, full size
	}
	if cmd, ok := m.railClick(msg); ok {
		return cmd
	}
	if cmd, ok := m.itemClick(msg); ok {
		return cmd
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
