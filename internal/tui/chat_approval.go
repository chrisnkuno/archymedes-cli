package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// approval is the agent asking before a tool runs, or (ask set) asking the person a question. It
// holds every key until answered: nothing else may be typed while the agent is paused, or a stray
// Enter would be read as consent.
type approval struct {
	req    acp.PermissionRequest
	ask    *acp.QuestionRequest
	cursor int
	typed  []rune       // a question's own answer, typed in place of an option
	picked map[int]bool // a multi-select question's chosen options
}

// queueApproval shows a request from the agent, or queues it behind the one on screen. Parallel
// tool calls ask together; replacing one request with the next left the first unanswered and its
// turn waiting for a reply that could never come.
func (m *Model) queueApproval(a *approval) {
	m.notifyWaiting(a)
	if m.approval == nil {
		m.approval = a
		return
	}
	m.approvals = append(m.approvals, a)
}

// nextApproval closes the answered request and shows the next one waiting, if any.
func (m *Model) nextApproval() {
	m.approval = nil
	if len(m.approvals) > 0 {
		m.approval, m.approvals = m.approvals[0], m.approvals[1:]
	}
}

// dropApprovals refuses whatever is still asking when the turn ends: nothing waits on those
// answers any more, and a dialog left over would hold the keyboard for a question already gone.
func (m *Model) dropApprovals() {
	for m.approval != nil {
		if m.approval.ask != nil {
			m.approval.ask.Answer("")
		} else {
			m.approval.req.Answer("")
		}
		m.nextApproval()
	}
}

// shortcuts are single keys for the decisions people make most, by option id.
var shortcuts = map[string]string{"y": "allow", "a": "allow_always", "p": "allow_pattern", "n": "deny", "N": "deny_always"}

// handle answers on a decision key and reports whether the dialog is finished.
func (a *approval) handle(msg tea.KeyPressMsg) (answered bool, choice string) {
	if a.ask != nil {
		return a.handleQuestion(msg)
	}
	options := a.req.Options
	switch key := msg.String(); key {
	case "up", "k", "shift+tab":
		a.cursor = (a.cursor - 1 + len(options)) % max(len(options), 1)
	case "down", "j", "tab":
		a.cursor = (a.cursor + 1) % max(len(options), 1)
	case "enter":
		if len(options) > 0 {
			return true, options[a.cursor].OptionID
		}
	case "esc", "ctrl+c":
		// Leaving the question is a refusal, never consent.
		return true, a.optionOr("deny")
	default:
		if len(key) == 1 && key[0] >= '1' && key[0] <= '9' {
			if index := int(key[0] - '1'); index < len(options) {
				return true, options[index].OptionID
			}
		}
		if id, ok := shortcuts[key]; ok && a.offers(id) {
			return true, id
		}
	}
	return false, ""
}

// handleQuestion: a digit or enter picks an option, typing writes an answer of one's own (enter
// sends it), space ticks an option of a multi-select, esc dismisses. The choice is the answer text.
func (a *approval) handleQuestion(msg tea.KeyPressMsg) (answered bool, choice string) {
	options := a.ask.Options
	typing := len(a.typed) > 0
	switch key := msg.String(); {
	case key == "esc" || key == "ctrl+c":
		return true, ""
	case key == "up" || key == "shift+tab":
		a.cursor = (a.cursor - 1 + len(options)) % max(len(options), 1)
	case key == "down" || key == "tab":
		a.cursor = (a.cursor + 1) % max(len(options), 1)
	case key == "backspace":
		if typing {
			a.typed = a.typed[:len(a.typed)-1]
		}
	case key == "enter":
		if typing {
			return true, string(a.typed)
		}
		if a.ask.MultiSelect {
			if chosen := a.chosen(); chosen != "" {
				return true, chosen
			}
		}
		if len(options) > 0 {
			return true, options[a.cursor]
		}
	case key == "space" && !typing && a.ask.MultiSelect && len(options) > 0:
		a.toggle(a.cursor)
	case !typing && len(key) == 1 && key[0] >= '1' && key[0] <= '9' && int(key[0]-'1') < len(options):
		index := int(key[0] - '1')
		if a.ask.MultiSelect {
			a.cursor = index
			a.toggle(index)
			return false, ""
		}
		return true, options[index]
	case msg.Text != "":
		a.typed = append(a.typed, []rune(msg.Text)...)
	}
	return false, ""
}

func (a *approval) toggle(index int) {
	if a.picked == nil {
		a.picked = map[int]bool{}
	}
	a.picked[index] = !a.picked[index]
}

// chosen is a multi-select's ticked options, in their listed order.
func (a *approval) chosen() string {
	var labels []string
	for i, label := range a.ask.Options {
		if a.picked[i] {
			labels = append(labels, label)
		}
	}
	return strings.Join(labels, ", ")
}

// paste types into a question's answer; an approval takes no text.
func (a *approval) paste(text string) {
	if a.ask != nil {
		a.typed = append(a.typed, []rune(strings.ReplaceAll(strings.TrimRight(text, "\r\n"), "\r", ""))...)
	}
}

func (a *approval) offers(id string) bool {
	for _, option := range a.req.Options {
		if option.OptionID == id {
			return true
		}
	}
	return false
}

// optionOr is id when offered; otherwise "" (ACP's cancelled outcome, which the agent reads as deny).
func (a *approval) optionOr(id string) string {
	if a.offers(id) {
		return id
	}
	return ""
}

// view draws the dialog; waiting is how many more requests are queued behind it.
func (a *approval) view(th theme.Theme, width, waiting int) string {
	// The box is drawn at X=1, so its total (text + padding 2 + border 2) must fit in width-1.
	inner := max(min(width-5, 90), 8)
	if a.ask != nil {
		return a.questionView(th, inner, waiting)
	}
	var b strings.Builder
	title := th.Title.Render("Allow this?")
	if waiting > 0 {
		title += th.Faint.Render(fmt.Sprintf("  %d more waiting", waiting))
	}
	b.WriteString(title + "\n")
	b.WriteString(th.Body.Render(ansi.Wrap(a.req.ToolCall.Title, inner, "")) + "\n\n")
	keyFor := map[string]string{}
	for k, id := range shortcuts {
		keyFor[id] = k
	}
	for i, option := range a.req.Options {
		label := fmt.Sprintf("%d. %s", i+1, option.Name)
		if k := keyFor[option.OptionID]; k != "" {
			label += th.Faint.Render(" (" + k + ")")
		}
		if i == a.cursor {
			b.WriteString(th.Title.Render("› ") + th.Strong.Render(ansi.Truncate(label, inner-2, "…")))
		} else {
			b.WriteString("  " + th.Body.Render(ansi.Truncate(label, inner-2, "…")))
		}
		b.WriteString("\n")
	}
	b.WriteString(th.Faint.Render("enter choose · esc deny"))
	return lipgloss.NewStyle().
		Border(th.Border).BorderForeground(th.Warning).
		Padding(0, 1).Width(inner + 2).
		Render(b.String())
}

func (a *approval) questionView(th theme.Theme, inner, waiting int) string {
	var b strings.Builder
	title := th.Title.Render("Question")
	if waiting > 0 {
		title += th.Faint.Render(fmt.Sprintf("  %d more waiting", waiting))
	}
	b.WriteString(title + "\n")
	b.WriteString(th.Body.Render(ansi.Wrap(a.ask.Question, inner, "")) + "\n\n")
	for i, option := range a.ask.Options {
		label := fmt.Sprintf("%d. %s", i+1, option)
		if a.ask.MultiSelect {
			box := "[ ] "
			if a.picked[i] {
				box = "[x] "
			}
			label = box + label
		}
		if i == a.cursor && len(a.typed) == 0 {
			b.WriteString(th.Title.Render("› ") + th.Strong.Render(ansi.Truncate(label, inner-2, "…")))
		} else {
			b.WriteString("  " + th.Body.Render(ansi.Truncate(label, inner-2, "…")))
		}
		b.WriteString("\n")
	}
	if len(a.ask.Options) > 0 {
		b.WriteString("\n")
	}
	// The typed answer shows its end: the part being written is the part worth seeing.
	if len(a.typed) > 0 {
		b.WriteString(th.Title.Render("› ") + th.Body.Render(ansi.TruncateLeft(string(a.typed)+"▏", max(ansi.StringWidth(string(a.typed))+1-(inner-2), 0), "…")) + "\n")
	} else {
		b.WriteString(th.Faint.Render("  type your own answer…") + "\n")
	}
	hints := "enter send · esc dismiss"
	switch {
	case len(a.typed) == 0 && a.ask.MultiSelect && len(a.ask.Options) > 0:
		hints = "space or 1-9 tick · enter send · esc dismiss"
	case len(a.typed) == 0 && len(a.ask.Options) > 0:
		hints = "1-9 or enter choose · type to answer · esc dismiss"
	}
	b.WriteString(th.Faint.Render(hints))
	return lipgloss.NewStyle().
		Border(th.Border).BorderForeground(th.Primary).
		Padding(0, 1).Width(inner + 2).
		Render(b.String())
}
