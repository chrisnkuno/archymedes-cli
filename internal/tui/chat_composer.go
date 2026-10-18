package tui

import (
	"regexp"
	"strings"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

const maxComposerLines = 8

// maxComposerRows is how much can be written, in rows as wrapped: far past anything typed, but a
// bound. Without it the textarea falls back to treating its visible height as a cap on logical
// lines, and a ninth line could not be started.
const maxComposerRows = 5000

// composer is the input box: a textarea that grows with its content, plus sent-message history
// and slash-command completion. Enter belongs to the composer's owner (send); the textarea only
// ever sees the keys that insert a newline.
type composer struct {
	area     textarea.Model
	custom   []command // the project's and the user's own /commands
	history  []string
	histPos  int    // len(history) when not browsing
	draft    string // what was typed before browsing started
	complete []completion
	compPos  int
	// files is the project's file list, once read, for @path completion.
	files []string
}

// mentionPattern is an @path being typed at the end of the input.
var mentionPattern = regexp.MustCompile(`(^|\s)@([^\s]*)$`)

// mentionFragment is the @path at the end of value: where its @ is, and what follows it.
func mentionFragment(value string) (at int, fragment string, ok bool) {
	match := mentionPattern.FindStringSubmatchIndex(value)
	if match == nil {
		return 0, "", false
	}
	return match[4] - 1, value[match[4]:match[5]], true
}

// matchingMentions completes a fragment against the project's files: prefix matches first, then
// substring matches, as the terminal CLI did, so a path the agent is given is one that exists.
func matchingMentions(files []string, fragment string) []completion {
	fragment = strings.ToLower(fragment)
	var prefixed, contained []completion
	for _, file := range files {
		lower := strings.ToLower(file)
		switch {
		case strings.HasPrefix(lower, fragment):
			prefixed = append(prefixed, completion{path: file})
		case fragment != "" && strings.Contains(lower, fragment):
			contained = append(contained, completion{path: file})
		}
	}
	out := append(prefixed, contained...)
	if len(out) > 50 {
		out = out[:50]
	}
	return out
}

func newComposer(th theme.Theme) composer {
	area := textarea.New()
	area.Placeholder = "Ask Friday · / for commands · !command runs it here"
	area.ShowLineNumbers = false
	area.Prompt = ""
	area.CharLimit = 0
	// The textarea counts its own rows as it wraps them (by word, with a column kept for the cursor
	// at a line's end), so it sizes itself; counting characters here undercounted every sentence
	// that wrapped early and hid its first line in a box that had room to grow.
	area.DynamicHeight = true
	area.MinHeight, area.MaxHeight, area.MaxContentHeight = 1, maxComposerLines, maxComposerRows
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

// continueLine turns a `\` typed just before enter into a line break, as a shell does: the one way
// to a new line that every terminal can send (Windows Terminal reports shift+enter as enter and
// keeps alt+enter for full screen). True when it did.
func (c *composer) continueLine() bool {
	value := c.area.Value()
	if !strings.HasSuffix(value, `\`) || !c.cursorAtEnd() {
		return false
	}
	c.area.SetValue(value[:len(value)-1] + "\n")
	c.refreshCompletions()
	return true
}

// newlineKey is the new-line key to show: shift+enter where the terminal can tell it from enter,
// else the `\` continuation, which every terminal can send.
func (m *Model) newlineKey() string {
	if m.shiftEnter {
		return "shift+enter"
	}
	return `\ enter`
}

// cursorAtEnd: the cursor is after the last character of the last line.
func (c *composer) cursorAtEnd() bool {
	lines := strings.Split(c.area.Value(), "\n")
	return c.area.Line() == len(lines)-1 && c.area.Column() >= len([]rune(lines[len(lines)-1]))
}

// pasteText is pasted text with Windows line endings made one break each. The textarea reads `\r`
// and `\n` as a break apiece, so a paste from a Windows program doubled every line.
func pasteText(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
}

// take empties the box and remembers what was in it.
func (c *composer) take() string {
	text := strings.TrimSpace(c.area.Value())
	if text != "" && (len(c.history) == 0 || c.history[len(c.history)-1] != text) {
		c.history = append(c.history, text)
	}
	c.histPos, c.draft = len(c.history), ""
	c.area.Reset()
	c.refreshCompletions()
	return text
}

// browse moves through history: only on a single line, and only from its first row going up or
// its last going down, so up/down still move the cursor through a message that wraps or spans
// several lines.
func (c *composer) browse(delta int) bool {
	if strings.Contains(c.area.Value(), "\n") || len(c.history) == 0 {
		return false
	}
	if info := c.area.LineInfo(); (delta < 0 && info.RowOffset > 0) || (delta > 0 && info.RowOffset < info.Height-1) {
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
	return true
}

func (c *composer) refreshCompletions() {
	c.complete = nil
	for _, cmd := range matchingCommands(c.area.Value(), c.custom...) {
		c.complete = append(c.complete, completion{command: cmd})
	}
	if _, fragment, ok := mentionFragment(c.area.Value()); ok && len(c.complete) == 0 && c.files != nil {
		c.complete = matchingMentions(c.files, fragment)
	}
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
	if chosen.path != "" {
		at, _, _ := mentionFragment(c.area.Value())
		c.area.SetValue(c.area.Value()[:at] + "@" + chosen.path + " ")
		c.area.MoveToEnd()
		c.complete = nil
		return true
	}
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
		if cmd.path != "" {
			text = ansi.Truncate("@"+cmd.path, width-3, "…")
		}
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
