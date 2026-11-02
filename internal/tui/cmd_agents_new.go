package tui

import (
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// Starting a helper yourself, with its role chosen from the list rather than remembered: /agent
// with nothing after it, n in the Inspector, or "+ new" on the rail's Agents. The roles come from
// the engine (session command "roles"); the helper starts as /agent starts one ("spawn").

// newHelper asks the engine for its roles; the picker opens when they arrive (commandDone).
func (m *Model) newHelper() tea.Cmd {
	return m.sessionCommand("roles", "")
}

// helperRole is one role in the picker; name "" is "Friday picks".
type helperRole struct{ name, status, detail string }

type newHelperDialog struct {
	roles  []helperRole
	cursor int
	input  textinput.Model
	// typed is what the message box held when the picker opened: the task, taken if it is used.
	typed string
}

func newNewHelperDialog(m *Model, result acp.CommandResult) *newHelperDialog {
	d := &newHelperDialog{roles: []helperRole{{status: "Friday picks the role", detail: "a helper that can change files in a git repository, else one that only reads"}}}
	for _, it := range result.Items {
		d.roles = append(d.roles, helperRole{it.Text, it.Status, it.Detail})
	}
	in := textinput.New()
	in.Placeholder = "what the helper should do"
	in.Prompt = "› "
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Prompt, s.Focused.Text, s.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	in.SetStyles(s)
	d.typed = strings.TrimSpace(m.input.value())
	in.SetValue(d.typed)
	in.CursorEnd()
	in.Focus()
	d.input = in
	return d
}

func (d *newHelperDialog) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		return true, nil
	case "up", "shift+tab":
		d.cursor = (d.cursor + len(d.roles) - 1) % len(d.roles)
		return false, nil
	case "down", "tab":
		d.cursor = (d.cursor + 1) % len(d.roles)
		return false, nil
	case "enter":
		task := strings.TrimSpace(d.input.Value())
		if task == "" {
			return false, m.toast(toastInfo, "Type what the helper should do, then enter")
		}
		if d.typed != "" && strings.TrimSpace(m.input.value()) == d.typed {
			m.input.take() // the message box held this task: it went to the helper
		}
		if role := d.roles[d.cursor].name; role != "" {
			task = role + " " + task
		}
		return true, m.startAgent(task)
	}
	var cmd tea.Cmd
	d.input, cmd = d.input.Update(msg)
	return false, cmd
}

func (d *newHelperDialog) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 84)
	inner := max(width-4, 8)
	d.input.SetWidth(max(inner-2, 4))
	var b strings.Builder
	b.WriteString(th.Faint.Render(ansi.Truncate("It works in the background; its card, the rail and the Inspector (→) follow it.", inner, "…")) + "\n\n")
	for i, r := range d.roles {
		name := r.name
		if name == "" {
			name = "auto"
		}
		line := padRight(name, 9) + " " + padRight(r.status, 14) + " " + r.detail
		if i == d.cursor {
			b.WriteString(selectedBar(m, padRight(ansi.Truncate("› "+line, inner, "…"), inner)) + "\n")
		} else {
			b.WriteString(th.Body.Render("  "+padRight(name, 9)) + th.Faint.Render(ansi.Truncate(" "+padRight(r.status, 14)+" "+r.detail, max(inner-11, 1), "…")) + "\n")
		}
	}
	b.WriteString("\n" + d.input.View() + "\n")
	b.WriteString(th.Faint.Render(ansi.Truncate("↑↓ role · enter start · esc cancel", inner, "")))
	return frame(th, "New helper", b.String(), width)
}
