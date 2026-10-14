package tui

import (
	"slices"
	"strings"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
)

// handleKey routes one key press, most urgent first: the approval (the agent is paused on it), an
// open dialog, a window capturing every key (the Keys app waiting for a binding), the desktop's own
// keys (apps, windows), the focused window, and finally Chat, where what is left is typing.
func (m *Model) handleKey(msg tea.KeyPressMsg) tea.Cmd {
	if m.sel.shown {
		escape := msg.String() == "esc"
		m.sel.clear() // any key moves on from a highlight; esc only dismisses it
		if escape {
			return nil
		}
	}
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
	w := m.activeWindow()
	if c, ok := w.(capturing); ok && c.capturing() {
		_, cmd := w.handle(m, msg)
		return cmd
	}
	if cmd, ok := m.shellKey(msg); ok {
		m.quitArmed = false
		return tea.Batch(cmd, m.animate())
	}
	if w != nil {
		if closed, cmd := w.handle(m, msg); closed {
			if i := m.windowIndex(w); i > 0 {
				m.closeWindow(i)
			}
			return cmd
		} else {
			return cmd
		}
	}
	return m.chatKey(msg)
}

func (m *Model) windowIndex(w window) int {
	for i, open := range m.windows {
		if open == w {
			return i + 1
		}
	}
	return 0
}

// chatKey is a key for the Chat window: session keys, reading the transcript, and typing.
func (m *Model) chatKey(msg tea.KeyPressMsg) tea.Cmd {
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
			return m.scrollTo(0)
		case m.phase == busy:
			return m.cancelTurn()
		}
		return nil
	case key.Matches(msg, k.Send):
		// A command typed out in full runs, even when a longer one also matches (/model, /models).
		if len(m.input.complete) > 0 && !m.namesCommand(m.input.value()) && m.input.accept() {
			if c := matchingCommands(strings.TrimSpace(m.input.value()), m.custom...); len(c) != 1 || c[0].args != "" {
				return nil // a command that takes an argument waits for it
			}
		}
		return m.submit()
	case key.Matches(msg, k.Complete) && len(m.input.complete) == 0 && m.offerStarter():
		return nil // on the home screen tab offers a request to start from
	case key.Matches(msg, k.Complete) && m.input.accept():
		return nil
	case key.Matches(msg, k.Mode):
		return m.setMode(nextMode(m.mode))
	case key.Matches(msg, k.Expand):
		m.expanded = !m.expanded
		return nil
	case key.Matches(msg, k.PageUp):
		return m.scrollBy(max(m.transcriptHeight()-2, 1))
	case key.Matches(msg, k.PageDown):
		return m.scrollBy(-max(m.transcriptHeight()-2, 1))
	case key.Matches(msg, k.LineUp):
		return m.scrollBy(1)
	case key.Matches(msg, k.LineDown):
		return m.scrollBy(-1)
	case key.Matches(msg, k.Top):
		m.stopScroll()
		m.tr.toTop()
		return nil
	case key.Matches(msg, k.Bottom):
		return m.scrollTo(0)
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
	cmd := m.input.update(msg)
	// The first @ typed reads the project's files, so the paths can be completed.
	if _, _, ok := mentionFragment(m.input.value()); ok && m.knownFiles == nil && !m.filesLoading {
		return tea.Batch(cmd, m.listFiles())
	}
	return cmd
}

func (m *Model) namesCommand(input string) bool {
	name := strings.TrimPrefix(strings.TrimSpace(input), "/")
	for _, c := range append(slices.Clone(commands), m.custom...) {
		if strings.HasPrefix(input, "/") && c.name == name {
			return true
		}
	}
	return false
}
