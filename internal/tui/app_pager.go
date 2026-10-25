package tui

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// pager is a full-screen reader over a long text — the transcript (/pager, /find, ctrl+f) or a file
// (/files, /cat) — on the design of Glow's pager: a Bubbles viewport with a line-number gutter, a
// title bar, search, and copy. It is an overlay that owns the whole frame.
//
// Search does not use viewport.SetHighlights: in bubbles v2.2.1 its ranges are offsets into the
// escape-stripped text while it counts lines in the styled one, so on coloured content it marks the
// wrong place. Matches are found and drawn here, from each line's stripped text.
type pager struct {
	label   string
	lines   []string // as drawn
	plain   []string // the same lines without styling, for search and copy
	vp      viewport.Model
	input   textinput.Model
	typing  bool // the search prompt is open
	query   string
	matches []int // line indices containing query
	current int   // index into matches
	note    string
}

func newPager(m *Model, title string, lines []string) *pager {
	p := &pager{label: title, lines: lines, plain: make([]string, len(lines))}
	for i, line := range lines {
		p.plain[i] = ansi.Strip(line)
	}
	p.vp = viewport.New()
	p.vp.SoftWrap = true
	p.vp.MouseWheelEnabled = true
	digits := len(fmt.Sprint(len(lines)))
	gutter := m.th.Faint
	p.vp.LeftGutterFunc = func(g viewport.GutterContext) string {
		if g.Soft || g.Index >= g.TotalLines {
			return strings.Repeat(" ", digits) + " │ "
		}
		return gutter.Render(fmt.Sprintf("%*d", digits, g.Index+1)) + gutter.Render(" │ ")
	}
	in := textinput.New()
	in.Prompt = "/"
	in.Placeholder = "search"
	styles := textinput.DefaultStyles(!m.th.Light)
	styles.Focused.Prompt, styles.Focused.Text, styles.Focused.Placeholder = m.th.Key, m.th.Body, m.th.Faint
	in.SetStyles(styles)
	p.input = in
	p.refresh(m)
	return p
}

// transcriptPager opens the session so far, every block expanded, at the newest line.
func (m *Model) transcriptPager() *pager {
	ctx := renderCtx{th: m.th, md: m.md, width: max(m.width-10, 20), expanded: true, root: m.projectRoot()}
	p := newPager(m, "transcript", m.tr.allLines(ctx))
	p.vp.GotoBottom()
	return p
}

// search finds every line containing query, case-insensitively, and shows the last match before
// the end — the most recent mention is usually the one being looked for.
func (p *pager) search(m *Model, query string) {
	p.query, p.matches, p.current = strings.TrimSpace(query), nil, 0
	if p.query != "" {
		needle := strings.ToLower(p.query)
		for i, line := range p.plain {
			if strings.Contains(strings.ToLower(line), needle) {
				p.matches = append(p.matches, i)
			}
		}
		p.current = max(len(p.matches)-1, 0)
	}
	p.refresh(m)
	p.reveal()
}

func (p *pager) step(m *Model, delta int) {
	if len(p.matches) == 0 {
		return
	}
	p.current = (p.current + delta + len(p.matches)) % len(p.matches)
	p.refresh(m)
	p.reveal()
}

func (p *pager) reveal() {
	if len(p.matches) > 0 {
		line := p.matches[p.current]
		// A third of the way down, so the match arrives with its context above it — but never past
		// the end, which on a short text would scroll its beginning out of sight for nothing.
		limit := max(p.vp.TotalLineCount()-p.vp.Height(), 0)
		p.vp.SetYOffset(min(max(line-p.vp.Height()/3, 0), limit))
	}
}

// refresh rebuilds the viewport's lines: matched lines are drawn from their plain text with the
// query marked, the current match more strongly than the rest.
func (p *pager) refresh(m *Model) {
	content := p.lines
	if len(p.matches) > 0 {
		content = append([]string(nil), p.lines...)
		mark := lipgloss.NewStyle().Foreground(m.th.Text).Background(m.th.Tint(m.th.Accent, 0.35))
		focus := lipgloss.NewStyle().Foreground(m.th.Bg).Background(m.th.Accent).Bold(true)
		for i, line := range p.matches {
			style := mark
			if i == p.current {
				style = focus
			}
			content[line] = markMatches(p.plain[line], p.query, m.th.Body, style)
		}
	}
	y := p.vp.YOffset()
	p.vp.SetContentLines(content)
	p.vp.SetYOffset(y)
}

// markMatches draws text with every case-insensitive occurrence of query in mark, the rest in base.
func markMatches(text, query string, base, mark lipgloss.Style) string {
	lower, needle := strings.ToLower(text), strings.ToLower(query)
	var b strings.Builder
	for len(text) > 0 {
		i := strings.Index(lower, needle)
		if i < 0 || needle == "" {
			b.WriteString(base.Render(text))
			break
		}
		b.WriteString(base.Render(text[:i]) + mark.Render(text[i:i+len(needle)]))
		text, lower = text[i+len(needle):], lower[i+len(needle):]
	}
	return b.String()
}

func (p *pager) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	if p.typing {
		switch msg.String() {
		case "esc":
			p.typing = false
			p.input.Blur()
		case "enter":
			p.typing = false
			p.input.Blur()
			p.search(m, p.input.Value())
		default:
			var cmd tea.Cmd
			p.input, cmd = p.input.Update(msg)
			return false, cmd
		}
		return false, nil
	}
	switch msg.String() {
	case "esc", "q", "ctrl+c":
		if p.query != "" && msg.String() == "esc" {
			p.search(m, "") // esc first clears a search, then closes
			return false, nil
		}
		return true, nil
	case "/", "ctrl+f":
		p.typing = true
		p.input.SetValue(p.query)
		p.input.CursorEnd()
		return false, p.input.Focus()
	case "n":
		p.step(m, 1)
	case "N":
		p.step(m, -1)
	case "g", "home":
		p.vp.GotoTop()
	case "G", "end":
		p.vp.GotoBottom()
	case "c":
		p.note = fmt.Sprintf("copied %d lines", len(p.plain))
		// OSC 52: the terminal's clipboard, which also works over SSH.
		return false, tea.SetClipboard(strings.Join(p.plain, "\n"))
	default:
		var cmd tea.Cmd
		p.vp, cmd = p.vp.Update(msg)
		return false, cmd
	}
	return false, nil
}

func (p *pager) view(m *Model) string {
	th := m.th
	p.vp.SetWidth(m.width)
	p.vp.SetHeight(max(m.windowHeight()-2, 1))

	percent := int(p.vp.ScrollPercent() * 100)
	right := th.Faint.Render(fmt.Sprintf("%d lines · %d%% ", len(p.lines), percent))
	title := " " + th.Title.Render(p.label)
	if p.query != "" {
		count := "no matches"
		if len(p.matches) > 0 {
			count = fmt.Sprintf("%d of %d", p.current+1, len(p.matches))
		}
		title += th.Faint.Render("  “"+p.query+"” ") + th.Key.Render(count)
	}
	header := spread(title, right, m.width)

	var footer string
	switch {
	case p.typing:
		p.input.SetWidth(max(m.width-4, 4))
		footer = " " + p.input.View()
	case p.note != "":
		footer = " " + th.OK.Render(p.note)
		p.note = ""
	default:
		buttons := []button{{"/", "search"}, {"home", "top"}, {"end", "bottom"}, {"c", "copy"}, {"q", "close"}}
		if p.query != "" {
			buttons = append([]button{{"n", "next"}, {"N", "previous"}}, buttons...)
		}
		footer = m.hintBar(m.width, buttons...)
	}
	body := strings.Split(p.vp.View(), "\n")
	for len(body) < p.vp.Height() {
		body = append(body, "")
	}
	rows := append(append([]string{header}, body[:p.vp.Height()]...), ansi.Truncate(footer, m.width, ""))
	return strings.Join(rows, "\n")
}

func (p *pager) wheel(_ *Model, up bool) tea.Cmd {
	if up {
		p.vp.ScrollUp(wheelStep)
	} else {
		p.vp.ScrollDown(wheelStep)
	}
	return nil
}
