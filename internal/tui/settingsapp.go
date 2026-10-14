package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

// The Settings app (alt+s, /settings): every setting the terminal menu had, in sections, edited in
// place. The agent owns the fields and their validation (the same ones `archymedes settings` used),
// so what is accepted here is what is accepted there; a change is saved the moment it is confirmed.

type settingsApp struct {
	list      *acp.SettingsList
	err       string
	cursor    int
	filter    string
	filtering bool
	// Editing one row: a choice list, or a text field (masked for a secret).
	editing bool
	choice  int
	input   textinput.Model
	saving  bool
	note    string
	rowTop  int // first drawn row, for click mapping
	// armed is the key a first "d" asked to clear; a second "d" on it clears, any other key disarms.
	armed      string
	rowIndexes []int
}

type settingsLoadedMsg struct {
	list acp.SettingsList
	err  error
}

type settingSavedMsg struct {
	key    string
	result acp.SettingsSetResult
	err    error
}

func newSettingsApp(m *Model) *settingsApp {
	in := textinput.New()
	in.Prompt = "› "
	st := textinput.DefaultStyles(!m.th.Light)
	st.Focused.Prompt, st.Focused.Text, st.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	in.SetStyles(st)
	return &settingsApp{input: in}
}

func (s *settingsApp) title() string { return "Settings" }
func (s *settingsApp) key() string   { return "settings" }

func (s *settingsApp) capturing() bool { return s.editing || s.filtering }

func (m *Model) openSettings() tea.Cmd {
	for _, w := range m.windows {
		if s, ok := w.(*settingsApp); ok {
			m.openWindow(s)
			return m.loadSettings()
		}
	}
	m.openWindow(newSettingsApp(m))
	return m.loadSettings()
}

func (m *Model) loadSettings() tea.Cmd {
	if m.agent == nil {
		return m.toast(toastWarn, "The agent is not ready yet")
	}
	agent := m.agent
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		list, err := agent.Settings(ctx)
		return settingsLoadedMsg{list, err}
	}
}

func (m *Model) settingsWindow() *settingsApp {
	for _, w := range m.windows {
		if s, ok := w.(*settingsApp); ok {
			return s
		}
	}
	return nil
}

func (m *Model) settingsLoaded(msg settingsLoadedMsg) {
	s := m.settingsWindow()
	if s == nil {
		return
	}
	if msg.err != nil {
		s.err = msg.err.Error()
		return
	}
	s.list, s.err = &msg.list, ""
}

// visible are the rows that pass the filter, as indexes into the list.
func (s *settingsApp) visible() []int {
	if s.list == nil {
		return nil
	}
	var out []int
	needle := strings.ToLower(s.filter)
	for i, r := range s.list.Rows {
		if needle == "" || strings.Contains(strings.ToLower(r.Label+" "+r.Key+" "+r.Section), needle) {
			out = append(out, i)
		}
	}
	return out
}

func (s *settingsApp) current() *acp.SettingRow {
	vis := s.visible()
	if len(vis) == 0 {
		return nil
	}
	s.cursor = min(max(s.cursor, 0), len(vis)-1)
	return &s.list.Rows[vis[s.cursor]]
}

func (s *settingsApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	key := msg.String()
	if s.saving {
		return false, nil
	}
	if s.editing {
		return false, s.editKey(m, msg)
	}
	if s.filtering {
		switch key {
		case "enter", "esc":
			s.filtering = false
		case "backspace":
			if r := []rune(s.filter); len(r) > 0 {
				s.filter = string(r[:len(r)-1]) // a character, not a byte
			}
		default:
			if msg.Text != "" {
				s.filter += msg.Text
			}
		}
		s.cursor = 0
		return false, nil
	}
	armedKey := s.armed
	s.armed = ""
	switch key {
	case "esc", "q":
		if s.filter != "" {
			s.filter = ""
			return false, nil
		}
		return true, nil
	case "up", "k":
		s.cursor--
	case "down", "j":
		s.cursor++
	case "pgup":
		s.cursor -= 10
	case "pgdown":
		s.cursor += 10
	case "home":
		s.cursor = 0
	case "end":
		s.cursor = 1 << 20
	case "/":
		s.filtering = true
	case "r":
		return false, m.loadSettings()
	case "d", "delete":
		// Two presses: one stray key must not throw away a saved API key.
		if r := s.current(); r != nil && r.IsSet {
			if armedKey == r.Key {
				return false, s.save(m, r.Key, "")
			}
			s.armed = r.Key
		}
	case "enter", "e":
		return false, s.begin(m)
	}
	s.current()
	return false, nil
}

// begin starts editing the highlighted row.
func (s *settingsApp) begin(m *Model) tea.Cmd {
	r := s.current()
	if r == nil {
		return nil
	}
	s.editing, s.note = true, ""
	if r.Kind == "choice" && len(r.Choices) > 0 {
		s.choice = 0
		for i, c := range r.Choices {
			if c.Value == r.Value {
				s.choice = i
			}
		}
		return nil
	}
	s.input.Reset()
	s.input.Placeholder = r.Key
	if r.Kind == "secret" {
		s.input.EchoMode, s.input.EchoCharacter = textinput.EchoPassword, '•'
	} else {
		s.input.EchoMode = textinput.EchoNormal
		s.input.SetValue(r.Value)
		s.input.CursorEnd()
	}
	return s.input.Focus()
}

func (s *settingsApp) editKey(m *Model, msg tea.KeyPressMsg) tea.Cmd {
	r := s.current()
	if r == nil {
		s.editing = false
		return nil
	}
	key := msg.String()
	if key == "esc" {
		s.editing = false
		s.input.Blur()
		return nil
	}
	if r.Kind == "choice" && len(r.Choices) > 0 {
		switch key {
		case "up", "k":
			s.choice = (s.choice - 1 + len(r.Choices)) % len(r.Choices)
		case "down", "j":
			s.choice = (s.choice + 1) % len(r.Choices)
		case "enter":
			return s.save(m, r.Key, r.Choices[s.choice].Value)
		}
		return nil
	}
	if key == "enter" {
		value := strings.TrimSpace(s.input.Value())
		if r.Kind == "secret" {
			value = cleanKey(value)
		}
		return s.save(m, r.Key, value)
	}
	var cmd tea.Cmd
	s.input, cmd = s.input.Update(msg)
	return cmd
}

// paste goes into the text field being edited (a key is the common case).
func (s *settingsApp) paste(m *Model, text string) tea.Cmd {
	r := s.current()
	if !s.editing || r == nil || r.Kind == "choice" {
		return nil
	}
	if r.Kind == "secret" {
		text = cleanKey(text)
	} else {
		text = strings.TrimSpace(strings.ReplaceAll(text, "\n", " "))
	}
	s.input.SetValue(s.input.Value() + text)
	s.input.CursorEnd()
	return nil
}

func (s *settingsApp) save(m *Model, key, value string) tea.Cmd {
	if m.agent == nil {
		return nil
	}
	s.saving, s.err = true, ""
	agent := m.agent
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		result, err := agent.SetSetting(ctx, key, value)
		return settingSavedMsg{key, result, err}
	}
}

func (m *Model) settingSaved(msg settingSavedMsg) tea.Cmd {
	s := m.settingsWindow()
	if s == nil {
		return nil
	}
	s.saving = false
	switch {
	case msg.err != nil:
		s.err = msg.err.Error()
		return nil
	case !msg.result.OK:
		s.err = msg.result.Error // stay in the editor: the message says what to change
		return nil
	}
	s.editing, s.err = false, ""
	s.input.Blur()
	if s.list != nil {
		for i := range s.list.Rows {
			if s.list.Rows[i].Key == msg.key {
				s.list.Rows[i].Value, s.list.Rows[i].IsSet = msg.result.Value, msg.result.IsSet
			}
		}
	}
	if msg.key == "ARCHYMEDES_THEME" && msg.result.IsSet {
		m.applyTheme(msg.result.Value)
	}
	what := "Saved"
	if !msg.result.IsSet {
		what = "Cleared"
	}
	// Only the theme changes what is on screen now; the agent reads the rest when a session starts.
	when := " · applies from the next session"
	if msg.key == "ARCHYMEDES_THEME" {
		when = ""
	}
	return m.toast(toastInfo, what+" "+msg.key+when)
}

func (s *settingsApp) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	for pos := range s.rowIndexes {
		if m.zones.frame.Get(fmt.Sprintf("setting:%d", pos)).InBounds(msg) {
			if s.editing || s.saving {
				return nil
			}
			s.cursor = pos
			return s.begin(m)
		}
	}
	return nil
}

func (s *settingsApp) view(m *Model) string {
	th, width, height := m.th, m.width, max(m.windowHeight(), 1)
	head := th.Strong.Render("Settings")
	if s.list != nil {
		head += th.Faint.Render("  " + ansi.Truncate(s.list.File, max(width-40, 10), "…"))
	}
	hint := "↑/↓ move · enter edit · d clear · / filter · r reload · esc close"
	switch {
	case s.armed != "":
		hint = "press d again to clear " + s.armed + " · any other key keeps it"
	case s.editing:
		hint = "enter save · esc cancel"
	case s.filtering:
		hint = "type to filter · enter done · esc clear"
	}
	lines := []string{" " + head, " " + th.Faint.Render(hint)}
	if s.filter != "" || s.filtering {
		lines = append(lines, " "+th.Highlight.Render("filter: ")+th.Body.Render(s.filter))
	}
	switch {
	case s.err != "" && s.list == nil:
		lines = append(lines, "", " "+th.Bad.Render(ansi.Truncate(s.err, width-2, "…")))
		return strings.Join(fitLines(lines, width, height), "\n")
	case s.list == nil:
		lines = append(lines, "", " "+m.spin.View()+th.Faint.Render(" reading settings…"))
		return strings.Join(fitLines(lines, width, height), "\n")
	}
	vis := s.visible()
	s.current()
	var rows []string // drawn rows, with section headers between
	var pos []int     // for each drawn row: its index in vis, or -1 for a header
	last := ""
	for i, idx := range vis {
		r := s.list.Rows[idx]
		if r.Section != last {
			last = r.Section
			rows, pos = append(rows, " "+th.Title.Render(r.Section)), append(pos, -1)
		}
		value := th.Faint.Render("not set")
		if r.IsSet {
			value = th.Body.Render(r.Value)
		}
		if r.OverriddenByEnvironment {
			value += th.Warn.Render("  (environment overrides)")
		}
		label := padRight(ansi.Truncate(r.Label, max(width/2-4, 12), "…"), max(width/2-3, 13))
		line := "   " + th.Body.Render(label) + value
		if i == s.cursor {
			line = " " + th.Title.Render("› ") + th.Strong.Render(label) + value
		}
		rows, pos = append(rows, ansi.Truncate(line, width, "…")), append(pos, i)
	}
	editorRows := 0
	var editor []string
	if s.editing {
		editor = s.editor(m, width)
		editorRows = len(editor) + 1
	}
	room := max(height-len(lines)-editorRows-1, 1)
	// Keep the cursor row in view.
	cursorAt := 0
	for i, p := range pos {
		if p == s.cursor {
			cursorAt = i
		}
	}
	top := max(0, min(cursorAt-room/2, len(rows)-room))
	s.rowIndexes = s.rowIndexes[:0]
	for i := top; i < min(top+room, len(rows)); i++ {
		row := rows[i]
		if pos[i] >= 0 {
			row = mark(m.zones.frame, fmt.Sprintf("setting:%d", pos[i]), row)
			s.rowIndexes = append(s.rowIndexes, pos[i])
		}
		lines = append(lines, row)
	}
	if len(vis) == 0 {
		lines = append(lines, "", " "+th.Faint.Render("No setting matches."))
	}
	if s.editing {
		lines = append(lines, "")
		lines = append(lines, editor...)
	}
	if s.err != "" {
		lines = append(lines, " "+th.Bad.Render(ansi.Truncate(s.err, width-2, "…")))
	}
	return strings.Join(fitLines(lines, width, height), "\n")
}

// editor is the choice list or the text field for the row being edited.
func (s *settingsApp) editor(m *Model, width int) []string {
	th := m.th
	r := s.current()
	if r == nil {
		return nil
	}
	out := []string{" " + th.Strong.Render(ansi.Truncate(r.Label, width-2, "…"))}
	if r.Kind == "choice" && len(r.Choices) > 0 {
		start := max(0, min(s.choice-3, len(r.Choices)-7))
		for i := start; i < min(start+7, len(r.Choices)); i++ {
			c := r.Choices[i]
			if i == s.choice {
				out = append(out, " "+th.Title.Render("› "+ansi.Truncate(c.Label, width-6, "…")))
			} else {
				out = append(out, "   "+th.Faint.Render(ansi.Truncate(c.Label, width-6, "…")))
			}
		}
		return out
	}
	s.input.SetWidth(max(width-6, 8))
	out = append(out, " "+s.input.View())
	if s.saving {
		out = append(out, " "+m.spin.View()+th.Faint.Render(" saving…"))
	} else if r.Kind == "secret" {
		out = append(out, " "+th.Faint.Render("paste the key · it is hidden · empty clears it"))
	}
	return out
}
