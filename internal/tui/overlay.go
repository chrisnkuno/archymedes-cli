package tui

import (
	"fmt"
	"image/color"
	"slices"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

// overlay is a modal over the transcript: it owns the keyboard until it closes. The approval
// dialog is not one of these; it is the agent's, and takes precedence over any of them.
type overlay interface {
	// handle returns true once the overlay should close.
	handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd)
	view(m *Model) string
}

// frame is the box every overlay is drawn in.
func frame(th theme.Theme, title, body string, width int) string {
	style := lipgloss.NewStyle().Border(th.Border).BorderForeground(th.BorderFocus).Padding(0, 1).Width(width)
	return style.Render(theme.Gradient(title, th.Primary, th.Secondary, true) + "\n" + body)
}

// overlayWidth is a box's text width: preferred, at least 16, and never more than the screen minus
// the box's two border columns.
func overlayWidth(m *Model, preferred int) int {
	return max(min(max(min(m.width-4, preferred), 16), m.width-2), 1)
}

// --- help ---

type helpOverlay struct{}

func (helpOverlay) handle(_ *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	return slices.Contains([]string{"esc", "?", "q", "enter", "ctrl+c"}, msg.String()), nil
}

func (helpOverlay) view(m *Model) string {
	width := overlayWidth(m, 96)
	h := m.help
	h.SetWidth(width - 4)
	h.ShowAll = true
	var cmds strings.Builder
	for _, c := range commands {
		usage := "/" + c.name
		if c.args != "" {
			usage += " " + c.args
		}
		desc := ansi.Truncate(c.help, max(width-4-34, 0), "…")
		cmds.WriteString(m.th.Key.Render(padRight(usage, 34)) + m.th.Faint.Render(desc) + "\n")
	}
	body := h.FullHelpView(m.keys.fullHelp()) + "\n\n" + m.th.Strong.Render("Commands") + "\n" + strings.TrimRight(cmds.String(), "\n") +
		"\n\n" + m.th.Faint.Render("esc to close")
	return frame(m.th, "Keys and commands", body, width)
}

// --- command palette ---

type paletteEntry struct {
	label, hint string
	run         func(m *Model) tea.Cmd
}

type paletteOverlay struct {
	filter  textinput.Model
	entries []paletteEntry
	shown   []paletteEntry
	cursor  int
}

func newPalette(m *Model) *paletteOverlay {
	in := textinput.New()
	in.Placeholder = "type to filter"
	in.Prompt = "› "
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Prompt, s.Focused.Text, s.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	in.SetStyles(s)
	in.Focus()
	p := &paletteOverlay{filter: in}
	for _, c := range commands {
		if c.args != "" && c.name != "mode" && c.name != "model" && c.name != "diff" && c.name != "undo" {
			continue // needs an argument the palette cannot ask for; the theme picker covers /theme
		}
		c := c
		p.entries = append(p.entries, paletteEntry{"/" + c.name, c.help, func(m *Model) tea.Cmd { return c.run(m, "") }})
	}
	p.entries = append(p.entries,
		paletteEntry{"Choose a theme…", "ctrl+t", func(m *Model) tea.Cmd { m.openOverlay(newThemePicker(m)); return nil }},
		paletteEntry{"Keys and commands", "?", func(m *Model) tea.Cmd { m.openOverlay(helpOverlay{}); return nil }},
	)
	p.refilter()
	return p
}

func (p *paletteOverlay) refilter() {
	p.shown = rankEntries(p.entries, p.filter.Value())
	p.cursor = min(p.cursor, max(len(p.shown)-1, 0))
}

func (p *paletteOverlay) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c", "ctrl+p":
		return true, nil
	case "up", "ctrl+k", "shift+tab":
		p.cursor = (p.cursor - 1 + max(len(p.shown), 1)) % max(len(p.shown), 1)
	case "down", "ctrl+j", "tab":
		p.cursor = (p.cursor + 1) % max(len(p.shown), 1)
	case "enter":
		if len(p.shown) == 0 {
			return false, nil
		}
		m.overlay = nil // the entry may open another overlay
		return false, p.shown[p.cursor].run(m)
	default:
		var cmd tea.Cmd
		p.filter, cmd = p.filter.Update(msg)
		p.refilter()
		return false, cmd
	}
	return false, nil
}

func (p *paletteOverlay) view(m *Model) string {
	width := overlayWidth(m, 64)
	p.filter.SetWidth(width - 6)
	rows := min(len(p.shown), max(m.transcriptHeight()-6, 3))
	start := max(0, min(p.cursor-rows+1, len(p.shown)-rows))
	var b strings.Builder
	b.WriteString(p.filter.View() + "\n")
	for i := start; i < start+rows && i < len(p.shown); i++ {
		e := p.shown[i]
		// Two columns: the entry, then what it does in whatever width is left.
		labelWidth := min(20, (width-4)/2)
		label := padRight(ansi.Truncate(e.label, labelWidth, "…"), labelWidth+1)
		hint := ansi.Truncate(e.hint, max(width-4-labelWidth-1, 0), "…")
		if i == p.cursor {
			b.WriteString(lipgloss.NewStyle().Foreground(m.th.Text).Background(m.th.Tint(m.th.Primary, 0.3)).Bold(true).Render(padRight(label+hint, width-4)))
		} else {
			b.WriteString(m.th.Body.Render(label) + m.th.Faint.Render(hint))
		}
		b.WriteString("\n")
	}
	if len(p.shown) == 0 {
		b.WriteString(m.th.Faint.Render("nothing matches") + "\n")
	}
	b.WriteString(m.th.Faint.Render(fmt.Sprintf("%d of %d · enter run · esc close", len(p.shown), len(p.entries))))
	return frame(m.th, "Commands", b.String(), width)
}

// rankEntries keeps entries whose label holds the query's letters in order, best first: a prefix,
// then a substring, then a scattered match with the fewest gaps.
func rankEntries(entries []paletteEntry, query string) []paletteEntry {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return entries
	}
	type scored struct {
		e     paletteEntry
		score int
	}
	var out []scored
	for _, e := range entries {
		label := strings.ToLower(strings.TrimPrefix(e.label, "/"))
		switch {
		case strings.HasPrefix(label, query):
			out = append(out, scored{e, 0})
		case strings.Contains(label, query):
			out = append(out, scored{e, 1})
		default:
			if gaps, ok := subsequence(label, query); ok {
				out = append(out, scored{e, 2 + gaps})
			}
		}
	}
	slices.SortStableFunc(out, func(a, b scored) int { return a.score - b.score })
	result := make([]paletteEntry, len(out))
	for i, s := range out {
		result[i] = s.e
	}
	return result
}

func subsequence(text, query string) (gaps int, ok bool) {
	i, last := 0, -1
	for j, r := range text {
		if i < len(query) && r == rune(query[i]) {
			if last >= 0 && j != last+1 {
				gaps++
			}
			last, i = j, i+1
		}
	}
	return gaps, i == len(query)
}

// --- theme picker, with a live preview ---

type themePicker struct {
	names    []string
	cursor   int
	original string
}

func newThemePicker(m *Model) *themePicker {
	names := theme.Names()
	return &themePicker{names: names, cursor: max(slices.Index(names, m.th.Name), 0), original: m.th.Name}
}

func (t *themePicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		m.applyTheme(t.original) // a preview is not a choice
		return true, nil
	case "enter":
		return true, m.toast(toastInfo, "Theme: "+t.names[t.cursor])
	case "up", "k", "shift+tab":
		t.cursor = (t.cursor - 1 + len(t.names)) % len(t.names)
	case "down", "j", "tab":
		t.cursor = (t.cursor + 1) % len(t.names)
	default:
		return false, nil
	}
	m.applyTheme(t.names[t.cursor])
	return false, nil
}

func (t *themePicker) view(m *Model) string {
	width := overlayWidth(m, 44)
	var b strings.Builder
	for i, name := range t.names {
		th, _ := theme.Load(name)
		swatch := ""
		for _, c := range []color.Color{th.Primary, th.Secondary, th.Accent, th.Success, th.Warning, th.Error} {
			swatch += lipgloss.NewStyle().Foreground(c).Render("●")
		}
		label := padRight(name, 16)
		if i == t.cursor {
			b.WriteString(m.th.Title.Render("› "+label) + swatch)
		} else {
			b.WriteString(m.th.Body.Render("  "+label) + swatch)
		}
		b.WriteString("\n")
	}
	b.WriteString(m.th.Faint.Render("↑/↓ preview · enter keep · esc revert"))
	return frame(m.th, "Theme", b.String(), width)
}

// --- toasts: what the session says that is not part of the conversation ---

type toastKind int

const (
	toastInfo toastKind = iota
	toastWarn
)

type toast struct {
	id   int
	kind toastKind
	text string
}

type toastExpiredMsg struct{ id int }

const toastLife = 3 * time.Second

func (m *Model) toast(kind toastKind, text string) tea.Cmd {
	m.toastSeq++
	id := m.toastSeq
	m.toasts = append(m.toasts, toast{id: id, kind: kind, text: text})
	if len(m.toasts) > 3 {
		m.toasts = m.toasts[len(m.toasts)-3:]
	}
	return tea.Tick(toastLife, func(time.Time) tea.Msg { return toastExpiredMsg{id} })
}

func (m *Model) expireToast(id int) {
	m.toasts = slices.DeleteFunc(m.toasts, func(t toast) bool { return t.id == id })
}

func (m *Model) toastView(t toast) string {
	accent := m.th.Primary
	if t.kind == toastWarn {
		accent = m.th.Warning
	}
	text := ansi.Truncate(t.text, max(min(m.width-8, 60), 8), "…")
	return lipgloss.NewStyle().
		Border(lipgloss.Border{Left: "▌"}, false, false, false, true).BorderForeground(accent).
		Background(m.th.Surface).Foreground(m.th.Text).Padding(0, 1).
		Render(text)
}

func (m *Model) openOverlay(o overlay) { m.overlay = o }
