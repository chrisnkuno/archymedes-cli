package tui

import (
	"cmp"
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
		if answered, choice := m.approval.handle(msg); answered && m.approval.ask != nil {
			m.approval.ask.Answer(choice)
			m.nextApproval()
			if choice == "" {
				return m.toast(toastInfo, "Question dismissed; the agent carries on without an answer")
			}
			return nil
		} else if answered {
			m.approval.req.Answer(choice)
			title := m.approval.req.ToolCall.Title
			m.nextApproval()
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
	if m.bar.on {
		if cmd, ok := m.barKey(msg); ok {
			return tea.Batch(cmd, m.animate())
		}
	}
	w := m.activeWindow()
	if c, ok := w.(capturing); ok && c.capturing() {
		var cmd tea.Cmd
		m.within(func() { _, cmd = w.handle(m, msg) })
		return cmd
	}
	if cmd, ok := m.shellKey(msg); ok {
		m.quitArmed = false
		return tea.Batch(cmd, m.animate())
	}
	if w != nil {
		var closed bool
		var cmd tea.Cmd
		m.within(func() { closed, cmd = w.handle(m, msg) })
		if closed && msg.String() == "esc" {
			m.stepOut() // esc steps out to the bars; q, ctrl+w or ✕ close the window
			return cmd
		}
		if closed {
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
	if m.tr.sel != nil {
		if cmd, ok := m.transcriptKey(msg); ok {
			return cmd
		}
	}
	if m.desk.focused && m.landingVisible() {
		if cmd, ok := m.deskKey(msg); ok {
			return cmd
		}
	}
	if msg.String() == "up" && m.input.value() == "" && m.landingVisible() && len(m.input.complete) == 0 {
		m.desk.focused = true // ↑ from an empty input: onto the desktop's icons
		return nil
	}
	if m.vim.on {
		if cmd, ok := m.vimKey(msg); ok {
			return cmd
		}
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
		if m.stopShell() {
			return nil
		}
		switch {
		case len(m.input.complete) > 0:
			m.input.complete = nil
		case !m.tr.following():
			return m.scrollTo(0)
		case m.phase == busy:
			return m.cancelTurn()
		case m.input.value() == "":
			m.stepOut() // nothing to stop or close: esc steps out to the bars
		}
		return nil
	case key.Matches(msg, k.Send):
		if m.input.continueLine() {
			return nil // `\` then enter: a new line, not a send
		}
		// A command typed out in full runs, even when a longer one also matches (/model, /models).
		if len(m.input.complete) > 0 && !m.namesCommand(m.input.value()) && m.input.accept() {
			if c := matchingCommands(strings.TrimSpace(m.input.value()), m.custom...); len(c) != 1 || c[0].args != "" {
				return nil // a command that takes an argument waits for it
			}
		}
		return m.submit()
	case key.Matches(msg, k.Complete) && len(m.input.complete) == 0 && m.offerStarter():
		return nil // on the home screen tab offers a request to start from
	case key.Matches(msg, k.Complete) && len(m.input.complete) == 0 && len(m.shownHints()) > 0:
		m.applyHint(m.shownHints()[0])
		return nil
	case key.Matches(msg, k.Complete) && len(m.input.complete) == 0 && m.offerNextStep():
		return nil // after a turn tab offers its next steps
	case key.Matches(msg, k.Suggest1, k.Suggest2, k.Suggest3):
		for i, b := range []key.Binding{k.Suggest1, k.Suggest2, k.Suggest3} {
			if key.Matches(msg, b) {
				m.useSuggestion(i)
			}
		}
		return nil
	case key.Matches(msg, k.Complete) && m.input.accept():
		return nil
	case key.Matches(msg, k.Mode):
		return m.setMode(nextMode(cmp.Or(m.pendingMode, m.mode)))
	case key.Matches(msg, k.Expand):
		m.expanded = !m.expanded
		return nil
	case key.Matches(msg, k.Rail):
		return m.toggleRail()
	case key.Matches(msg, k.Inspect) && len(m.input.complete) == 0 && !m.landingVisible() &&
		(msg.String() != "right" || m.input.value() == ""):
		return m.openInspector(nil) // → on an empty input: what the sub-agents are doing, the latest edit
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
	case (msg.String() == "up" || msg.String() == "down") && len(m.input.complete) > 0:
		delta := map[string]int{"up": -1, "down": 1}[msg.String()]
		m.input.compPos = (m.input.compPos + delta + len(m.input.complete)) % len(m.input.complete)
		return nil
	case msg.String() == "up" && m.input.value() == "" && m.enterTranscript():
		return nil // ↑ from an empty input: onto the newest block of the conversation
	case key.Matches(msg, k.History):
		delta := -1
		if strings.HasSuffix(msg.String(), "down") {
			delta = 1
		}
		if m.input.browse(delta) {
			return nil
		}
	}
	before := m.input.value()
	cmd := tea.Batch(m.input.update(msg), m.typed(before))
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
