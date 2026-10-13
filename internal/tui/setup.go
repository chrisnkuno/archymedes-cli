package tui

import (
	"context"
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
	input     textinput.Model
	err       string
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
		return true, m.quit()
	}
	if s.saving || len(s.providers) == 0 {
		if key == "esc" {
			return true, m.quit()
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
			return true, m.quit()
		}
		return false, nil
	}
	switch key {
	case "esc":
		s.entering, s.err = false, ""
		s.input.Blur()
		return false, nil
	case "enter":
		value := strings.TrimSpace(s.input.Value())
		if value == "" {
			return false, nil
		}
		s.saving, s.err = true, ""
		agent, provider := m.agent, s.chosen().ID
		return false, tea.Batch(func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			result, err := agent.SaveSetup(ctx, provider, value)
			return setupSavedMsg{result, err}
		})
	}
	var cmd tea.Cmd
	s.input, cmd = s.input.Update(msg)
	return false, cmd
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
	cmds := []tea.Cmd{m.toast(toastInfo, "Key saved to "+msg.result.File), m.openSession()}
	if msg.result.Note != "" {
		cmds = append(cmds, m.toast(toastWarn, msg.result.Note))
	}
	return tea.Batch(cmds...)
}

func (s *setupOverlay) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 72)
	inner := max(width-4, 8)
	var b strings.Builder
	b.WriteString(th.Body.Render(ansi.Wrap("Archymedes needs a model to work with. Pick a provider and paste its key; it is saved to your settings and checked before use.", inner, "")) + "\n\n")
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
		b.WriteString("\n" + th.Faint.Render("enter choose · esc quit"))
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
		b.WriteString("\n\n" + th.Faint.Render("enter save · esc back"))
	}
	return frame(th, "Set up a model", b.String(), width)
}
