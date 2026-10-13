package tui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

// resumePicker lists this project's stored sessions, newest first, filtered by title as you type.
type resumePicker struct {
	sessions []acp.SessionSummary
	loaded   bool
	err      string
	filter   textinput.Model
	shown    []acp.SessionSummary
	cursor   int
}

func newResumePicker(m *Model) *resumePicker {
	in := textinput.New()
	in.Placeholder = "filter by what you asked"
	in.Prompt = "› "
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Prompt, s.Focused.Text, s.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	in.SetStyles(s)
	in.Focus()
	return &resumePicker{filter: in}
}

func (p *resumePicker) load(msg sessionsLoadedMsg) {
	p.loaded = true
	if msg.err != nil {
		p.err = msg.err.Error()
		return
	}
	p.sessions = msg.sessions
	p.refilter()
}

func (p *resumePicker) refilter() {
	entries := make([]paletteEntry, len(p.sessions))
	for i, s := range p.sessions {
		entries[i] = paletteEntry{label: s.Title, hint: fmt.Sprint(i)}
	}
	p.shown = p.shown[:0]
	for _, e := range rankEntries(entries, p.filter.Value()) {
		var i int
		fmt.Sscan(e.hint, &i)
		p.shown = append(p.shown, p.sessions[i])
	}
	p.cursor = min(p.cursor, max(len(p.shown)-1, 0))
}

func (p *resumePicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		return true, nil
	case "up", "ctrl+k":
		p.cursor = (p.cursor - 1 + max(len(p.shown), 1)) % max(len(p.shown), 1)
	case "down", "ctrl+j", "tab":
		p.cursor = (p.cursor + 1) % max(len(p.shown), 1)
	case "enter":
		if len(p.shown) == 0 {
			return false, nil
		}
		chosen := p.shown[p.cursor]
		if chosen.ID == m.session.ID {
			return true, m.toast(toastInfo, "That is this session")
		}
		return true, m.resumeSession(chosen.ID)
	default:
		var cmd tea.Cmd
		p.filter, cmd = p.filter.Update(msg)
		p.refilter()
		return false, cmd
	}
	return false, nil
}

func (p *resumePicker) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 80)
	inner := max(width-4, 8)
	p.filter.SetWidth(max(inner-2, 4))
	var b strings.Builder
	b.WriteString(p.filter.View() + "\n")
	switch {
	case !p.loaded:
		b.WriteString(m.spin.View() + th.Faint.Render(" reading this project's sessions…") + "\n")
	case p.err != "":
		b.WriteString(th.Bad.Render(ansi.Wrap(p.err, inner, "")) + "\n")
	case len(p.sessions) == 0:
		b.WriteString(th.Faint.Render("No earlier sessions in this project.") + "\n")
	default:
		now := time.Now()
		rows := min(len(p.shown), max(m.transcriptHeight()-6, 3))
		start := max(0, min(p.cursor-rows+1, len(p.shown)-rows))
		for i := start; i < start+rows && i < len(p.shown); i++ {
			s := p.shown[i]
			when := padRight(relativeTime(s.UpdatedAt, now), 11)
			mark := "  "
			if s.ID == m.session.ID {
				mark = "● "
			}
			title := ansi.Truncate(strings.Join(strings.Fields(s.Title), " "), max(inner-14, 4), "…")
			if i == p.cursor {
				b.WriteString(lipgloss.NewStyle().Foreground(th.Text).Background(th.Tint(th.Primary, 0.3)).Bold(true).Render(padRight(mark+when+title, inner)))
			} else {
				b.WriteString(th.Highlight.Render(mark) + th.Faint.Render(when) + th.Body.Render(title))
			}
			b.WriteString("\n")
		}
		if len(p.shown) == 0 {
			b.WriteString(th.Faint.Render("nothing matches") + "\n")
		}
	}
	b.WriteString(th.Faint.Render(ansi.Truncate("enter resume · esc close", inner, "")))
	return frame(th, "Resume a session", b.String(), width)
}
