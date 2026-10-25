package tui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/gallery"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// The Sessions app (F4, /resume): this project's stored sessions, newest first, filtered by title
// as you type. ↑/↓ or the wheel move, enter or a second click resumes.
type resumePicker struct {
	sessions []acp.SessionSummary
	loaded   bool
	err      string
	filter   textinput.Model
	shown    []acp.SessionSummary
	list     listView
}

func (p *resumePicker) title() string { return "Sessions" }
func (p *resumePicker) key() string   { return "sessions" }

func (p *resumePicker) wheel(_ *Model, up bool) tea.Cmd {
	p.list.wheel(up, len(p.shown))
	return nil
}

// click selects a session; a second click on it resumes it.
func (p *resumePicker) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	if i, ok := p.list.clicked(m.zones.frame, msg, len(p.shown)); ok && p.list.clickRow(i) {
		closed, cmd := p.handle(m, keyPress("enter"))
		if closed {
			m.closeWindow(m.windowIndex(p))
		}
		return cmd
	}
	return nil
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
	p.list.clamp(len(p.shown))
}

func (p *resumePicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		return true, nil
	case "up", "down", "ctrl+k", "ctrl+j", "pgup", "pgdown":
		p.list.move(msg.String(), len(p.shown)) // letters are the filter's
	case "enter":
		if len(p.shown) == 0 {
			return false, nil
		}
		chosen := p.shown[p.list.cursor]
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
	width, height := m.width, max(m.windowHeight(), 1)
	inner := max(width-2, 8)
	p.filter.SetWidth(max(inner-2, 4))
	p.list.zone = "session"
	lines := []string{" " + p.filter.View(), ""}
	switch {
	case !p.loaded:
		lines = append(lines, " "+m.spin.View()+th.Faint.Render(" reading this project's sessions…"))
	case p.err != "":
		lines = append(lines, " "+th.Bad.Render(ansi.Truncate(p.err, inner, "…")))
	case len(p.sessions) == 0:
		if photo := m.photoCard(gallery.OfTheme("greek", 2), min(24, inner), 7); photo != nil {
			lines = append(lines, centreLines(photo, width)...)
		}
		lines = append(lines, "", " "+th.Faint.Render("No earlier sessions in this project; this one is the first."))
	case len(p.shown) == 0:
		lines = append(lines, " "+th.Faint.Render("nothing matches"))
	default:
		now := time.Now()
		from, to := p.list.window(len(p.shown), max(height-len(lines)-1, 1))
		for i := from; i < to; i++ {
			s := p.shown[i]
			badge := "  "
			if s.ID == m.session.ID {
				badge = "● "
			}
			elsewhere := ""
			if s.OpenElsewhere {
				elsewhere = " · open in another terminal"
			}
			title := strings.Join(strings.Fields(s.Title), " ")
			row := " " + th.Highlight.Render(badge) + th.Faint.Render(padRight(relativeTime(s.UpdatedAt, now), 11)) + th.Body.Render(title) + th.Faint.Render(elsewhere)
			lines = append(lines, p.list.row(m, m.zones.frame, i, row, width))
		}
	}
	does := "resume"
	if p.list.cursor < len(p.shown) && p.shown[p.list.cursor].OpenElsewhere {
		does = "open a copy (the original stays with the other terminal)"
	}
	lines = fitLines(lines, width, height-1)
	return strings.Join(append(lines, m.hintBar(width, button{"enter", does}, button{"esc", "close"})), "\n")
}
