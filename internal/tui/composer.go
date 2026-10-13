package tui

import (
	"strings"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

const maxComposerLines = 8

// composer is the input box: a textarea that grows with its content, plus sent-message history
// and slash-command completion. Enter belongs to the composer's owner (send); the textarea only
// ever sees the keys that insert a newline.
type composer struct {
	area     textarea.Model
	history  []string
	histPos  int    // len(history) when not browsing
	draft    string // what was typed before browsing started
	complete []command
	compPos  int
}

func newComposer(th theme.Theme) composer {
	area := textarea.New()
	area.Placeholder = "Ask Archymedes, or / for commands"
	area.ShowLineNumbers = false
	area.Prompt = ""
	area.CharLimit = 0
	area.MaxHeight = 0
	area.SetHeight(1)
	area.KeyMap.InsertNewline = key.NewBinding(key.WithKeys("shift+enter", "alt+enter", "ctrl+j"))
	c := composer{area: area}
	c.applyTheme(th)
	c.area.Focus()
	return c
}

func (c *composer) applyTheme(th theme.Theme) {
	s := textarea.DefaultStyles(!th.Light)
	for _, state := range []*textarea.StyleState{&s.Focused, &s.Blurred} {
		state.Base = lipgloss.NewStyle()
		state.Text = th.Body
		state.CursorLine = lipgloss.NewStyle()
		state.Placeholder = th.Faint
		state.EndOfBuffer = th.Faint
	}
	s.Cursor.Color = th.Primary
	c.area.SetStyles(s)
}

func (c *composer) value() string { return c.area.Value() }

func (c *composer) setWidth(width int) { c.area.SetWidth(max(width, 10)) }

// fit grows the box to its content, up to maxComposerLines; beyond that the textarea scrolls.
func (c *composer) fit() {
	lines := 0
	for _, line := range strings.Split(c.area.Value(), "\n") {
		lines += max(1, (ansi.StringWidth(line)+c.area.Width()-1)/max(c.area.Width(), 1))
	}
	c.area.SetHeight(min(max(lines, 1), maxComposerLines))
}

// take empties the box and remembers what was in it.
func (c *composer) take() string {
	text := strings.TrimSpace(c.area.Value())
	if text != "" && (len(c.history) == 0 || c.history[len(c.history)-1] != text) {
		c.history = append(c.history, text)
	}
	c.histPos, c.draft = len(c.history), ""
	c.area.Reset()
	c.fit()
	c.refreshCompletions()
	return text
}

// browse moves through history; only on a single-line input, so up/down still move the cursor
// inside a message being written over several lines.
func (c *composer) browse(delta int) bool {
	if strings.Contains(c.area.Value(), "\n") || len(c.history) == 0 {
		return false
	}
	if c.histPos == len(c.history) {
		c.draft = c.area.Value()
	}
	next := min(max(c.histPos+delta, 0), len(c.history))
	if next == c.histPos {
		return true
	}
	c.histPos = next
	if next == len(c.history) {
		c.area.SetValue(c.draft)
	} else {
		c.area.SetValue(c.history[next])
	}
	c.area.MoveToEnd()
	c.fit()
	return true
}

func (c *composer) refreshCompletions() {
	c.complete = matchingCommands(c.area.Value())
	if c.compPos >= len(c.complete) {
		c.compPos = 0
	}
}

// accept fills in the highlighted completion; true when there was one to take.
func (c *composer) accept() bool {
	if len(c.complete) == 0 {
		return false
	}
	chosen := c.complete[c.compPos]
	c.area.SetValue("/" + chosen.name + map[bool]string{true: " ", false: ""}[chosen.args != ""])
	c.area.MoveToEnd()
	c.refreshCompletions()
	if chosen.args != "" {
		c.complete = nil // the name is complete; what follows is an argument
	}
	return true
}

func (c *composer) update(msg tea.Msg) tea.Cmd {
	var cmd tea.Cmd
	c.area, cmd = c.area.Update(msg)
	c.fit()
	c.refreshCompletions()
	return cmd
}

// dropup draws the completion list that opens above the input, at most rows tall.
func (c *composer) dropup(th theme.Theme, width, rows int) []string {
	if len(c.complete) == 0 || rows <= 0 {
		return nil
	}
	start := max(0, min(c.compPos-rows+1, len(c.complete)-rows))
	end := min(start+rows, len(c.complete))
	var out []string
	for i := start; i < end; i++ {
		cmd := c.complete[i]
		line := "/" + cmd.name
		if cmd.args != "" {
			line += " " + cmd.args
		}
		// width-3: the "› " marker and the screen's one-column margin come on top of this.
		text := ansi.Truncate(padRight(line, 32)+"  "+cmd.help, width-3, "…")
		if i == c.compPos {
			out = append(out, th.Title.Render("› "+text))
		} else {
			out = append(out, th.Faint.Render("  "+text))
		}
	}
	return out
}

func padRight(s string, width int) string {
	if w := ansi.StringWidth(s); w < width {
		return s + strings.Repeat(" ", width-w)
	}
	return s
}
