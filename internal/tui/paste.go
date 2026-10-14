package tui

import (
	"charm.land/bubbles/v2/textinput"
	"fmt"
	"regexp"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// Paste, copy and selection. A terminal delivers a paste as one message (bracketed paste); it goes
// to whatever has the keyboard — a dialog's text field before the composer under it — instead of
// always landing in the composer, which is where a key pasted into the setup dialog used to vanish.

// pasteTarget is a dialog with a text field that takes pasted text.
type pasteTarget interface {
	paste(m *Model, text string) tea.Cmd
}

// routePaste hands text to the dialog that wants it, else to the composer. Nothing is typed into the
// composer behind an open dialog or an approval prompt: a stray paste must not become a message.
func (m *Model) routePaste(msg tea.Msg, text string) tea.Cmd {
	switch {
	case m.approval != nil:
		return nil
	case m.overlay != nil:
		if t, ok := m.overlay.(pasteTarget); ok {
			return t.paste(m, text)
		}
		return nil
	}
	if t, ok := m.activeWindow().(pasteTarget); ok {
		return t.paste(m, text)
	}
	if c, ok := m.activeWindow().(capturing); ok && c.capturing() {
		return nil
	}
	return m.input.update(msg)
}

// keyAssignment is a .env line's `NAME=` prefix. Only an upper-case name with an underscore
// (OPENROUTER_API_KEY) counts: a base64 key like "dGVzdA==" is itself letters followed by "=".
var keyAssignment = regexp.MustCompile(`^(?:export\s+)?[A-Z][A-Z0-9]*_[A-Z0-9_]*\s*=\s*`)

// cleanKey reduces what was pasted to the key itself: the first non-empty line, without the
// `export NAME=` a .env line or docs page carries, surrounding quotes, or stray whitespace.
func cleanKey(pasted string) string {
	for _, line := range strings.Split(pasted, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		line = keyAssignment.ReplaceAllString(line, "")
		return strings.Trim(strings.TrimSpace(line), "\"'`")
	}
	return ""
}

// lastReply is the newest reply the agent wrote, as the Markdown it sent.
func (m *Model) lastReply() string {
	for i := len(m.tr.items) - 1; i >= 0; i-- {
		if a, ok := m.tr.items[i].(*assistantItem); ok {
			if text := strings.TrimSpace(a.text.String()); text != "" {
				return text
			}
		}
	}
	return ""
}

var fence = regexp.MustCompile("(?s)```[^\\n]*\\n(.*?)```")

// lastCodeBlock is the contents of the newest fenced code block in the newest reply that has one.
func (m *Model) lastCodeBlock() string {
	for i := len(m.tr.items) - 1; i >= 0; i-- {
		if a, ok := m.tr.items[i].(*assistantItem); ok {
			if blocks := fence.FindAllStringSubmatch(a.text.String(), -1); len(blocks) > 0 {
				return strings.TrimRight(blocks[len(blocks)-1][1], "\n")
			}
		}
	}
	return ""
}

// cmdCopy puts the newest reply — or, with "code", its last code block — on the system clipboard
// (OSC 52, which works over ssh and in tmux where an external clipboard tool would not).
func (m *Model) cmdCopy(arg string) tea.Cmd {
	text, what := m.lastReply(), "reply"
	if strings.EqualFold(arg, "code") {
		text, what = m.lastCodeBlock(), "code block"
	}
	if text == "" {
		return m.toast(toastWarn, "Nothing to copy yet")
	}
	return tea.Batch(tea.SetClipboard(text), m.toast(toastInfo, fmt.Sprintf("Copied the last %s (%d lines)", what, strings.Count(text, "\n")+1)))
}

// cmdSelect hands the mouse back to the terminal, so a drag selects text and the terminal's own
// copy works; the app's clicks and wheel pause until it is switched back.
func (m *Model) cmdSelect(string) tea.Cmd {
	m.selecting = !m.selecting
	if m.selecting {
		return m.toast(toastInfo, "Select with the mouse, copy as usual · /select again returns the app's mouse")
	}
	return m.toast(toastInfo, "Mouse back in the app")
}

// Search boxes take a paste as typed text, on one line.
func pasteInto(in *textinput.Model, text string) tea.Cmd {
	var cmd tea.Cmd
	*in, cmd = in.Update(tea.PasteMsg{Content: strings.Join(strings.Fields(text), " ")})
	return cmd
}

func (p *modelPicker) paste(_ *Model, text string) tea.Cmd {
	cmd := pasteInto(&p.filter, text)
	p.refilter()
	return cmd
}

func (p *startMenu) paste(_ *Model, text string) tea.Cmd {
	cmd := pasteInto(&p.filter, text)
	p.refilter()
	return cmd
}

func (p *resumePicker) paste(_ *Model, text string) tea.Cmd {
	cmd := pasteInto(&p.filter, text)
	p.refilter()
	return cmd
}
