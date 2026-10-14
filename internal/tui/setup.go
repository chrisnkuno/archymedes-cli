package tui

import (
	"context"
	"fmt"

	"charm.land/lipgloss/v2"

	"github.com/chrisnkuno/archymedes-cli/internal/gallery"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

// setupOverlay is first run: no provider is usable yet, so before any session there is one
// question, which model to use, answered with a provider and a key. The agent checks and saves
// the key (the same settings file `archymedes settings` writes) and the session opens straight
// after. Leaving it quits, since there is nothing to talk to without it.
type setupOverlay struct {
	reason    string
	providers []acp.SetupProvider
	cursor    int
	entering  bool // the key step, rather than the provider list
	saving    bool
	// optional is /key from inside a session: esc closes the dialog instead of quitting, and a
	// saved key does not open another session.
	optional bool
	input    textinput.Model
	err      string
}

type setupSavedMsg struct {
	result acp.SetupResult
	err    error
}

func newSetup(m *Model, status acp.SetupStatus) *setupOverlay {
	s := &setupOverlay{reason: status.Reason}
	for _, p := range status.Providers {
		if p.KeyVariable != "" {
			s.providers = append(s.providers, p)
		}
	}
	in := textinput.New()
	in.EchoMode = textinput.EchoPassword
	in.EchoCharacter = '•'
	in.Prompt = "› "
	styles := textinput.DefaultStyles(!m.th.Light)
	styles.Focused.Prompt, styles.Focused.Text, styles.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	in.SetStyles(styles)
	s.input = in
	return s
}

func (s *setupOverlay) chosen() acp.SetupProvider { return s.providers[s.cursor] }

func (s *setupOverlay) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	key := msg.String()
	if key == "ctrl+c" {
		return true, s.leave(m)
	}
	if s.saving || len(s.providers) == 0 {
		if key == "esc" {
			return true, s.leave(m)
		}
		return false, nil
	}
	if !s.entering {
		switch key {
		case "up", "k", "shift+tab":
			s.cursor = (s.cursor - 1 + len(s.providers)) % len(s.providers)
		case "down", "j", "tab":
			s.cursor = (s.cursor + 1) % len(s.providers)
		case "enter":
			s.entering, s.err = true, ""
			s.input.Placeholder = s.chosen().KeyVariable
			s.input.Reset()
			return false, s.input.Focus()
		case "esc":
			return true, s.leave(m)
		}
		return false, nil
	}
	switch key {
	case "esc":
		s.entering, s.err = false, ""
		s.input.Blur()
		return false, nil
	case "enter":
		return false, s.save(m, s.input.Value())
	}
	var cmd tea.Cmd
	s.input, cmd = s.input.Update(msg)
	return false, cmd
}

// leave is esc at the top: first run has nothing to talk to without a key, so it quits; /key just closes.
func (s *setupOverlay) leave(m *Model) tea.Cmd {
	if s.optional {
		return nil
	}
	return m.quit()
}

// paste takes a key from the clipboard: into the field on the key step, and — so that pasting
// before choosing a provider is not a dead end — straight into the highlighted provider's field.
func (s *setupOverlay) paste(m *Model, text string) tea.Cmd {
	if s.saving || len(s.providers) == 0 {
		return nil
	}
	var focus tea.Cmd
	if !s.entering {
		s.entering, s.err = true, ""
		s.input.Placeholder = s.chosen().KeyVariable
		s.input.Reset()
		focus = s.input.Focus()
	}
	s.input.SetValue(cleanKey(text))
	s.err = ""
	return focus
}

// save checks and stores the key the person entered.
func (s *setupOverlay) save(m *Model, raw string) tea.Cmd {
	value := cleanKey(raw)
	if value == "" {
		return nil
	}
	{
		s.saving, s.err = true, ""
		agent, provider := m.agent, s.chosen().ID
		return tea.Batch(func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			result, err := agent.SaveSetup(ctx, provider, value)
			return setupSavedMsg{result, err}
		})
	}
}

// setupSaved finishes setup: on success the session opens; otherwise the key step says why.
func (m *Model) setupSaved(msg setupSavedMsg) tea.Cmd {
	s, ok := m.overlay.(*setupOverlay)
	if !ok {
		return nil
	}
	s.saving = false
	switch {
	case msg.err != nil:
		s.err = msg.err.Error()
		return nil
	case !msg.result.OK:
		s.err = msg.result.Error
		return nil
	}
	m.overlay = nil
	cmds := []tea.Cmd{m.toast(toastInfo, "Key saved to "+msg.result.File)}
	if s.optional {
		cmds = append(cmds, m.toast(toastInfo, "Use /model to switch to a model from it"), m.reloadProviders())
	} else {
		cmds = append(cmds, m.openSession())
	}
	if msg.result.Note != "" {
		cmds = append(cmds, m.toast(toastWarn, msg.result.Note))
	}
	return tea.Batch(cmds...)
}

func (s *setupOverlay) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 76)
	inner := max(width-4, 8)
	// A photo beside the words, where the dialog is wide enough to keep both readable.
	const photoCols, photoRows = 18, 8
	photo := []string(nil)
	if inner >= 62 {
		photo = m.photoCard(gallery.OfTheme("greek", 0), photoCols, photoRows)
	}
	if photo != nil {
		inner -= photoCols + 3
	}
	var b strings.Builder
	b.WriteString(th.Body.Render(ansi.Wrap("First, a model to work with. Pick a provider and paste its key; it is saved to your settings and checked before use.", inner, "")) + "\n\n")
	switch {
	case len(s.providers) == 0:
		b.WriteString(th.Warn.Render(ansi.Wrap(s.reason, inner, "")) + "\n\n")
		b.WriteString(th.Faint.Render("Run archymedes settings to configure a provider. esc to quit"))
	case !s.entering:
		for i, p := range s.providers {
			label := padRight(ansi.Truncate(p.Label, 26, "…"), 27)
			hint := ""
			if i == 0 {
				hint = "no paid account needed"
			}
			if p.Configured {
				hint = "configured"
			}
			hint = ansi.Truncate(hint, max(inner-29, 0), "…")
			if i == s.cursor {
				b.WriteString(th.Title.Render("› "+label) + th.Highlight.Render(hint))
			} else {
				b.WriteString(th.Body.Render("  "+label) + th.Faint.Render(hint))
			}
			b.WriteString("\n")
		}
		leave := "esc quit"
		if s.optional {
			leave = "esc close"
		}
		b.WriteString("\n" + th.Faint.Render("enter choose · or just paste a key · "+leave))
	default:
		p := s.chosen()
		b.WriteString(th.Strong.Render(p.Label) + "\n")
		if p.KeyURL != "" {
			b.WriteString(th.Faint.Render("Get a key: ") + th.Highlight.Render(ansi.Truncate(p.KeyURL, inner-11, "…")) + "\n")
		}
		s.input.SetWidth(max(inner-4, 4))
		b.WriteString("\n" + s.input.View() + "\n")
		switch {
		case s.saving:
			b.WriteString(m.spin.View() + th.Faint.Render(" checking the key…"))
		case s.err != "":
			b.WriteString(th.Bad.Render(ansi.Wrap(s.err, inner, "")))
		}
		b.WriteString("\n\n" + th.Faint.Render("paste the key (ctrl+v, or your terminal's paste) · enter save · esc back"))
	}
	body := b.String()
	if photo != nil {
		body = lipgloss.JoinHorizontal(lipgloss.Top, strings.Join(photo, "\n"), "   ", body)
	}
	return frame(th, "Welcome to Archymedes", body, width)
}

// cmdKey opens the key dialog from inside a session. With a provider named it goes straight to that
// provider's key field, so "/key openrouter" then paste is the whole job.
func (m *Model) cmdKey(arg string) tea.Cmd {
	if m.agent == nil {
		return m.toast(toastWarn, "The agent is not ready yet")
	}
	agent := m.agent
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		status, err := agent.SetupStatus(ctx)
		return keyDialogMsg{status: status, want: arg, err: err}
	}
}

type keyDialogMsg struct {
	status acp.SetupStatus
	want   string
	err    error
}

func (m *Model) openKeyDialog(msg keyDialogMsg) tea.Cmd {
	if msg.err != nil {
		return m.toast(toastWarn, "Could not read providers: "+msg.err.Error())
	}
	s := newSetup(m, msg.status)
	s.optional = true
	if len(s.providers) == 0 {
		return m.toast(toastWarn, "No provider here takes a plain key — run archymedes settings")
	}
	if want := strings.ToLower(strings.TrimSpace(msg.want)); want != "" {
		found := false
		for i, p := range s.providers {
			if strings.EqualFold(p.ID, want) || strings.Contains(strings.ToLower(p.Label), want) {
				s.cursor, found = i, true
				break
			}
		}
		if !found {
			return m.toast(toastWarn, fmt.Sprintf("No provider %q — /key lists them", msg.want))
		}
		s.entering = true
		s.input.Placeholder = s.chosen().KeyVariable
		m.openOverlay(s)
		return s.input.Focus()
	}
	m.openOverlay(s)
	return nil
}
