package tui

import (
	"strings"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
)

// handleKey routes one key press: the approval dialog first (the agent is paused on it), then an
// open overlay, then the keymap, and whatever is left is typing.
func (m *Model) handleKey(msg tea.KeyPressMsg) tea.Cmd {
	if m.approval != nil {
		if answered, choice := m.approval.handle(msg); answered {
			m.approval.req.Answer(choice)
			title := m.approval.req.ToolCall.Title
			m.approval = nil
			if choice == "" || strings.HasPrefix(choice, "deny") {
				return m.toast(toastWarn, "Denied: "+title)
			}
		}
		return nil
	}
	if m.overlay != nil {
		current := m.overlay
		closed, cmd := current.handle(m, msg)
		if closed && m.overlay == current {
			m.overlay = nil
		}
		return tea.Batch(cmd, m.animate())
	}

	k := m.keys
	if !key.Matches(msg, k.Interrupt) {
		m.quitArmed = false
	}
	switch {
	case key.Matches(msg, k.Interrupt):
		switch {
		case m.phase == busy:
			return m.cancelTurn()
		case m.input.value() != "":
			m.input.take()
		case m.quitArmed:
			return m.quit()
		default:
			m.quitArmed = true
		}
		return nil
	case key.Matches(msg, k.Quit) && m.input.value() == "":
		return m.quit()
	case key.Matches(msg, k.Cancel):
		switch {
		case len(m.input.complete) > 0:
			m.input.complete = nil
		case !m.tr.following():
			m.tr.toBottom()
		case m.phase == busy:
			return m.cancelTurn()
		}
		return nil
	case key.Matches(msg, k.Send):
		// A command typed out in full runs, even when a longer one also matches (/model, /models).
		if len(m.input.complete) > 0 && !namesCommand(m.input.value()) && m.input.accept() {
			if c := matchingCommands(strings.TrimSpace(m.input.value())); len(c) != 1 || c[0].args != "" {
				return nil // a command that takes an argument waits for it
			}
		}
		return m.submit()
	case key.Matches(msg, k.Complete) && m.input.accept():
		return nil
	case key.Matches(msg, k.Mode):
		return m.setMode(nextMode(m.mode))
	case key.Matches(msg, k.Expand):
		m.expanded = !m.expanded
		return nil
	case key.Matches(msg, k.Palette):
		m.openOverlay(newPalette(m))
		return nil
	case key.Matches(msg, k.Themes):
		m.openOverlay(newThemePicker(m))
		return nil
	case key.Matches(msg, k.Help) && m.input.value() == "":
		// Only on an empty input: "?" is also something people type.
		m.openOverlay(helpOverlay{})
		return nil
	case key.Matches(msg, k.PageUp):
		m.tr.scrollBy(max(m.transcriptHeight()-2, 1))
		return nil
	case key.Matches(msg, k.PageDown):
		m.tr.scrollBy(-max(m.transcriptHeight()-2, 1))
		return nil
	case key.Matches(msg, k.LineUp):
		m.tr.scrollBy(1)
		return nil
	case key.Matches(msg, k.LineDown):
		m.tr.scrollBy(-1)
		return nil
	case key.Matches(msg, k.Top):
		m.tr.toTop()
		return nil
	case key.Matches(msg, k.Bottom):
		m.tr.toBottom()
		return nil
	case key.Matches(msg, k.History):
		delta := map[string]int{"up": -1, "down": 1}[msg.String()]
		if len(m.input.complete) > 0 {
			m.input.compPos = (m.input.compPos + delta + len(m.input.complete)) % len(m.input.complete)
			return nil
		}
		if m.input.browse(delta) {
			return nil
		}
	}
	return m.input.update(msg)
}

func namesCommand(input string) bool {
	name := strings.TrimPrefix(strings.TrimSpace(input), "/")
	for _, c := range commands {
		if strings.HasPrefix(input, "/") && c.name == name {
			return true
		}
	}
	return false
}
