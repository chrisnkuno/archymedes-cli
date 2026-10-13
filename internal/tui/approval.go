package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

// approval is the agent asking before a tool runs. It holds every key until answered: nothing else
// may be typed while the agent is paused, or a stray Enter would be read as consent.
type approval struct {
	req    acp.PermissionRequest
	cursor int
}

// shortcuts are single keys for the decisions people make most, by option id.
var shortcuts = map[string]string{"y": "allow", "a": "allow_always", "p": "allow_pattern", "n": "deny", "N": "deny_always"}

// handle answers on a decision key and reports whether the dialog is finished.
func (a *approval) handle(msg tea.KeyPressMsg) (answered bool, choice string) {
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

func (a *approval) view(th theme.Theme, width int) string {
	// The box is drawn at X=1, so its total (text + padding 2 + border 2) must fit in width-1.
	inner := max(min(width-5, 90), 8)
	var b strings.Builder
	b.WriteString(th.Title.Render("Allow this?") + "\n")
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
