package tui

import (
	"fmt"
	"strconv"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// Comments on diff lines, as T3 Code has them: in Changes, [ and ] pick a line of the shown diff and
// c writes a note on it. The notes ride along with the next message to the agent, each naming its
// file, line and code, and are cleared once sent. Nothing is sent on its own: a comment is part of
// what the person says next.

// lineRef is what one drawn diff row points at: a line of a file, on the new side ('+' or ' ') or the
// old one ('-'). Rows that are not code (a hunk rule, a mode change) have no ref.
type lineRef struct {
	ok   bool
	line int
	side byte
	code string
}

type reviewComment struct {
	path string
	ref  lineRef
	text string
}

// diffLineRefs reads a unified diff as diffRows draws it, row for row.
func diffLineRefs(text string) []lineRef {
	var refs []lineRef
	oldLine, newLine := 0, 0
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		line = strings.ReplaceAll(ansi.Strip(line), "\t", "    ")
		switch {
		case strings.HasPrefix(line, "diff --git"), strings.HasPrefix(line, "index "),
			strings.HasPrefix(line, "--- "), strings.HasPrefix(line, "+++ "), strings.HasPrefix(line, "similarity index"):
			continue
		case strings.HasPrefix(line, "new file mode"), strings.HasPrefix(line, "deleted file mode"),
			strings.HasPrefix(line, "rename from"), strings.HasPrefix(line, "rename to"), strings.HasPrefix(line, "Binary files"),
			strings.HasPrefix(line, "old mode"), strings.HasPrefix(line, "new mode"), strings.HasPrefix(line, `\`):
			refs = append(refs, lineRef{})
		case strings.HasPrefix(line, "@@"):
			oldLine, newLine = hunkStart(line)
			refs = append(refs, lineRef{})
		case strings.HasPrefix(line, "+"):
			refs = append(refs, lineRef{true, newLine, '+', line[1:]})
			newLine++
		case strings.HasPrefix(line, "-"):
			refs = append(refs, lineRef{true, oldLine, '-', line[1:]})
			oldLine++
		default:
			refs = append(refs, lineRef{true, newLine, ' ', strings.TrimPrefix(line, " ")})
			oldLine++
			newLine++
		}
	}
	return refs
}

// withReviewComments appends the pending comments to a message and forgets them.
func (m *Model) withReviewComments(text string) string {
	if len(m.comments) == 0 {
		return text
	}
	var b strings.Builder
	b.WriteString(text)
	b.WriteString("\n\nMy comments on the diff:\n")
	for _, c := range m.comments {
		where := c.path + ":" + strconv.Itoa(c.ref.line)
		if c.ref.side == '-' {
			where += " (removed line)"
		}
		fmt.Fprintf(&b, "- %s `%s` — %s\n", where, strings.TrimSpace(ansi.Truncate(c.ref.code, 120, "…")), c.text)
	}
	m.comments = nil
	return strings.TrimRight(b.String(), "\n")
}

// commentAt is the comment on a file's line, if any.
func (m *Model) commentAt(path string, ref lineRef) int {
	for i, c := range m.comments {
		if c.path == path && c.ref.line == ref.line && c.ref.side == ref.side {
			return i
		}
	}
	return -1
}

// --- choosing a line in Changes ---

// moveLine selects the next (or previous) code line of the shown diff, scrolling it into view.
func (c *changesApp) moveLine(m *Model, delta int) {
	f, ok := c.selected()
	if !ok || c.diffs[f.Path] == nil {
		return
	}
	refs := c.diffs[f.Path].refs
	i := c.line
	if i < 0 {
		i = c.scroll - delta
	}
	for i += delta; i >= 0 && i < len(refs); i += delta {
		if refs[i].ok {
			c.line = i
			height := max(m.windowHeight()-2, 1)
			if i < c.scroll {
				c.scroll = i
			} else if i >= c.scroll+height {
				c.scroll = i - height + 1
			}
			return
		}
	}
}

// commentOnLine opens the note for the selected line (the first code line in view when none is).
func (c *changesApp) commentOnLine(m *Model) tea.Cmd {
	f, ok := c.selected()
	if !ok || c.diffs[f.Path] == nil {
		return nil
	}
	if c.line < 0 {
		c.moveLine(m, 1)
	}
	refs := c.diffs[f.Path].refs
	if c.line < 0 || c.line >= len(refs) || !refs[c.line].ok {
		return m.toast(toastWarn, "No line to comment on: ] picks one")
	}
	m.openOverlay(newCommentDialog(m, f.Path, refs[c.line]))
	return nil
}

// --- the note itself ---

type commentDialog struct {
	path  string
	ref   lineRef
	input textinput.Model
}

func newCommentDialog(m *Model, path string, ref lineRef) *commentDialog {
	in := textinput.New()
	in.Placeholder = "what should change here"
	in.Prompt = "› "
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Prompt, s.Focused.Text, s.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	in.SetStyles(s)
	if i := m.commentAt(path, ref); i >= 0 {
		in.SetValue(m.comments[i].text)
	}
	in.Focus()
	return &commentDialog{path: path, ref: ref, input: in}
}

func (d *commentDialog) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		return true, nil
	case "enter":
		text := strings.TrimSpace(d.input.Value())
		i := m.commentAt(d.path, d.ref)
		switch {
		case text == "" && i >= 0:
			m.comments = append(m.comments[:i], m.comments[i+1:]...)
			return true, m.toast(toastInfo, "Comment removed")
		case text == "":
			return true, nil
		case i >= 0:
			m.comments[i].text = text
		default:
			m.comments = append(m.comments, reviewComment{d.path, d.ref, text})
		}
		return true, m.toast(toastInfo, fmt.Sprintf("%s — sent with your next message", plural(len(m.comments), "comment")))
	}
	var cmd tea.Cmd
	d.input, cmd = d.input.Update(msg)
	return false, cmd
}

func (d *commentDialog) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 80)
	inner := max(width-4, 8)
	d.input.SetWidth(max(inner-2, 4))
	where := fmt.Sprintf("%s:%d", d.path, d.ref.line)
	code := strings.TrimSpace(d.ref.code)
	body := th.Faint.Render(ansi.Truncate(where, inner, "…")) + "\n" +
		th.Body.Render(ansi.Truncate(string(d.ref.side)+" "+code, inner, "…")) + "\n\n" +
		d.input.View() + "\n" +
		th.Faint.Render(ansi.Truncate("enter keep · empty enter removes it · esc cancel", inner, ""))
	return frame(th, "Comment on this line", body, width)
}
