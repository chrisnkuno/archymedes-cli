package tui

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/render"
)

// The start menu: the one place to find anything by typing — apps, every action, recent sessions
// and project files — each row showing the key that reaches it directly, so using the menu teaches
// the shortcuts. Opened with ctrl+space (or ctrl+p, or a click on ◇).

type paletteEntry struct {
	label, hint string
	section     string // app · action · session · file
	run         func(m *Model) tea.Cmd
}

type startMenu struct {
	filter  textinput.Model
	entries []paletteEntry // apps and actions; sessions join as they load
	files   []string       // searched only once something is typed
	shown   []paletteEntry
	cursor  int
}

func newStartMenu(m *Model) *startMenu {
	in := textinput.New()
	in.Placeholder = "type to find an app, action, session or file"
	in.Prompt = "› "
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Prompt, s.Focused.Text, s.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	in.SetStyles(s)
	in.Focus()
	p := &startMenu{filter: in, files: m.knownFiles}
	for _, app := range dockApps {
		app := app
		a, _ := findAction(app.id)
		p.entries = append(p.entries, paletteEntry{app.icon + " " + app.name, keyLabel(m.keys.keysFor(a)), "app", func(m *Model) tea.Cmd { return m.runAction(app.id) }})
	}
	for _, c := range append(slices.Clone(commands), m.custom...) {
		if c.args != "" && c.name != "mode" && c.name != "model" && c.name != "diff" && c.name != "undo" {
			continue // needs an argument the menu cannot ask for
		}
		c := c
		p.entries = append(p.entries, paletteEntry{"/" + c.name, c.help, "action", func(m *Model) tea.Cmd { return c.run(m, "") }})
	}
	p.addSessions(m)
	p.refilter()
	return p
}

// startMenuSources reads what the menu can offer beyond apps and actions: recent sessions, and the
// project's files when they have not been listed yet.
func (m *Model) startMenuSources() tea.Cmd {
	cmds := []tea.Cmd{m.loadSessions()}
	if m.knownFiles == nil && !m.filesLoading {
		cmds = append(cmds, m.listFiles())
	}
	return tea.Batch(cmds...)
}

// addSessions adds the recent sessions m knows of, newest first, once each.
func (p *startMenu) addSessions(m *Model) {
	for _, e := range p.entries {
		if e.section == "session" {
			return
		}
	}
	now := time.Now()
	for i, s := range m.recentSessions {
		if i == 8 {
			break
		}
		s := s
		if s.ID == m.session.ID {
			continue
		}
		title := strings.Join(strings.Fields(s.Title), " ")
		hint := relativeTime(s.UpdatedAt, now)
		if s.OpenElsewhere {
			hint += " · open in another terminal"
		}
		p.entries = append(p.entries, paletteEntry{"↺ " + title, hint, "session", func(m *Model) tea.Cmd { return m.resumeSession(s.ID) }})
	}
	p.refilter()
}

func (p *startMenu) refilter() {
	entries := p.entries
	if query := strings.TrimSpace(p.filter.Value()); query != "" {
		for _, f := range p.files {
			f := f
			entries = append(entries, paletteEntry{f, "open", "file", func(m *Model) tea.Cmd { return m.openFile(f) }})
		}
	}
	p.shown = rankEntries(entries, p.filter.Value())
	if len(p.shown) > 200 {
		p.shown = p.shown[:200]
	}
	p.cursor = min(p.cursor, max(len(p.shown)-1, 0))
}

func (p *startMenu) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch {
	case msg.String() == "esc" || msg.String() == "ctrl+c" || key.Matches(msg, m.keys.Start):
		return true, nil
	case msg.String() == "up" || msg.String() == "ctrl+k" || msg.String() == "shift+tab":
		p.cursor = (p.cursor - 1 + max(len(p.shown), 1)) % max(len(p.shown), 1)
	case msg.String() == "down" || msg.String() == "ctrl+j" || msg.String() == "tab":
		p.cursor = (p.cursor + 1) % max(len(p.shown), 1)
	case msg.String() == "pgup":
		p.cursor = max(p.cursor-10, 0)
	case msg.String() == "pgdown":
		p.cursor = max(min(p.cursor+10, len(p.shown)-1), 0)
	case msg.String() == "enter":
		if len(p.shown) == 0 {
			return false, nil
		}
		m.overlay = nil // the entry may open a window or another dialog
		return false, p.shown[p.cursor].run(m)
	default:
		var cmd tea.Cmd
		p.filter, cmd = p.filter.Update(msg)
		p.refilter()
		return false, cmd
	}
	return false, nil
}

func (p *startMenu) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 72)
	inner := max(width-4, 8)
	p.filter.SetWidth(max(inner-2, 4))
	rows := min(len(p.shown), max(m.windowHeight()-6, 3))
	start := max(0, min(p.cursor-rows+1, len(p.shown)-rows))
	var b strings.Builder
	b.WriteString(p.filter.View() + "\n")
	for i := start; i < start+rows && i < len(p.shown); i++ {
		e := p.shown[i]
		// Label, then what it does (or its key), then which kind of thing it is.
		labelWidth := min(32, inner/2)
		tag := " " + e.section
		hintWidth := max(inner-labelWidth-1-ansi.StringWidth(tag), 0)
		// A path keeps both ends (the file's name is at the end); other labels keep their start.
		short := ansi.Truncate(e.label, labelWidth, "…")
		if e.section == "file" {
			short = render.TruncateMiddle(e.label, labelWidth)
		}
		label := padRight(short, labelWidth+1)
		hint := padRight(ansi.Truncate(e.hint, hintWidth, "…"), hintWidth)
		row := th.Body.Render(label) + th.Key.Render(hint) + th.Faint.Render(tag)
		if i == p.cursor {
			row = lipgloss.NewStyle().Foreground(th.Text).Background(th.Tint(th.Primary, 0.3)).Bold(true).Render(ansi.Truncate(label+hint+tag, inner, ""))
		}
		b.WriteString(mark(m.zones.dialog, rowID(i), row))
		b.WriteString("\n")
	}
	if len(p.shown) == 0 {
		b.WriteString(th.Faint.Render("nothing matches") + "\n")
	}
	b.WriteString(th.Faint.Render(ansi.Truncate(fmt.Sprintf("%d found · enter open · esc close", len(p.shown)), inner, "")))
	return frame(th, "Start", b.String(), width)
}
