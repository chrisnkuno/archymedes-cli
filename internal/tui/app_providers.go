package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// The Providers app (alt+p, /providers): every provider, whether it is usable, what it still needs,
// and the model it would use — and the things a person does with that, one key each: use it, give it
// a key, pick one of its models, make it the default. It replaces a report the agent printed from a
// second process, which showed nothing while it ran and could not be acted on.

type providersApp struct {
	rows    []acp.ProviderOverview
	loaded  bool
	err     string
	cursor  int
	pending string // what is in flight, shown while it is
}

type providersLoadedMsg struct {
	rows []acp.ProviderOverview
	err  error
}

func (p *providersApp) title() string { return "Providers" }
func (p *providersApp) key() string   { return "providers" }

func (m *Model) providersWindow() *providersApp {
	for _, w := range m.windows {
		if p, ok := w.(*providersApp); ok {
			return p
		}
	}
	return nil
}

func (m *Model) openProviders() tea.Cmd {
	p := m.providersWindow()
	if p == nil {
		p = &providersApp{}
	}
	m.openWindow(p)
	return m.loadProviders()
}

func (m *Model) loadProviders() tea.Cmd {
	if m.agent == nil {
		return m.toast(toastWarn, "The agent is not ready yet")
	}
	agent := m.agent
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		rows, err := agent.Providers(ctx)
		return providersLoadedMsg{rows, err}
	}
}

// reloadProviders refreshes the app when it is open: after a key is saved or a default changes.
func (m *Model) reloadProviders() tea.Cmd {
	if m.providersWindow() == nil {
		return nil
	}
	return m.loadProviders()
}

func (m *Model) providersLoaded(msg providersLoadedMsg) {
	p := m.providersWindow()
	if p == nil {
		return
	}
	p.loaded, p.pending = true, ""
	if msg.err != nil {
		p.err = msg.err.Error()
		return
	}
	p.rows, p.err = msg.rows, ""
	p.cursor = min(p.cursor, max(len(p.rows)-1, 0))
}

func (p *providersApp) current() *acp.ProviderOverview {
	if len(p.rows) == 0 {
		return nil
	}
	p.cursor = min(max(p.cursor, 0), len(p.rows)-1)
	return &p.rows[p.cursor]
}

func (p *providersApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		return true, nil
	case "up", "k":
		p.cursor--
		p.current()
		return false, nil
	case "down", "j":
		p.cursor++
		p.current()
		return false, nil
	case "r":
		p.pending = "refreshing"
		return false, m.loadProviders()
	}
	row := p.current()
	if row == nil {
		return false, nil
	}
	switch msg.String() {
	case "enter", "m":
		// Set it up if it is not, then its models, fetched from the provider, to pick from.
		if !row.Configured {
			return false, m.openConnect(row.ID, "form")
		}
		return false, m.openConnect(row.ID, "models")
	case "K", "e", "ctrl+k":
		return false, m.openConnect(row.ID, "form") // change its key or base URL
	case "d":
		return false, p.makeDefault(m, *row)
	}
	return false, nil
}

func (p *providersApp) makeDefault(m *Model, row acp.ProviderOverview) tea.Cmd {
	if !row.Configured {
		return m.toast(toastWarn, row.Label+" is not set up yet: enter gives it a key")
	}
	if m.agent == nil {
		return nil
	}
	p.pending = "saving the default"
	agent, id := m.agent, row.ID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		result, err := agent.SetSetting(ctx, "ARCHYMEDES_PROVIDER", id)
		return defaultProviderMsg{label: row.Label, result: result, err: err}
	}
}

type defaultProviderMsg struct {
	label  string
	result acp.SettingsSetResult
	err    error
}

func (m *Model) defaultProviderSaved(msg defaultProviderMsg) tea.Cmd {
	if p := m.providersWindow(); p != nil {
		p.pending = ""
	}
	switch {
	case msg.err != nil:
		return m.toast(toastWarn, "Default not changed: "+msg.err.Error())
	case !msg.result.OK:
		return m.toast(toastWarn, "Default not changed: "+msg.result.Error)
	}
	return tea.Batch(m.toast(toastInfo, msg.label+" is the default for new sessions"), m.reloadProviders())
}

func (p *providersApp) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	for i := range p.rows {
		if m.zones.frame.Get(fmt.Sprintf("provider:%d", i)).InBounds(msg) {
			p.cursor = i
			return nil
		}
	}
	return nil
}

func (p *providersApp) view(m *Model) string {
	th, width, height := m.th, m.width, max(m.windowHeight(), 1)
	ready := 0
	for _, row := range p.rows {
		if row.Configured {
			ready++
		}
	}
	head := th.Strong.Render("Providers")
	if p.loaded {
		head += th.Faint.Render(fmt.Sprintf("  %d of %d ready", ready, len(p.rows)))
	}
	lines := []string{" " + head, " " + th.Faint.Render("↑/↓ move · enter connect or pick a model · e key & URL · d make default · r refresh · esc close")}
	switch {
	case !p.loaded:
		lines = append(lines, "", " "+m.spin.View()+th.Faint.Render(" asking the agent…"))
		return strings.Join(fitLines(lines, width, height), "\n")
	case p.err != "" && len(p.rows) == 0:
		lines = append(lines, "", " "+th.Bad.Render(ansi.Truncate(p.err, width-2, "…")))
		return strings.Join(fitLines(lines, width, height), "\n")
	}
	lines = append(lines, "")
	labelWidth := min(26, max(width/4, 12))
	modelWidth := min(30, max(width/4, 12))
	for i, row := range p.rows {
		dot, state := th.Faint.Render("○ "), th.Faint
		status := "needs " + strings.Join(row.Missing, ", ")
		switch {
		case row.ID == m.session.Info.Provider:
			dot, state, status = th.OK.Render("● "), th.OK, "in use"
		case row.Configured:
			dot, state, status = th.OK.Render("✓ "), th.Body, "ready"
		}
		if row.IsDefault {
			status += " · default"
		}
		label := padRight(ansi.Truncate(row.Label, labelWidth, "…"), labelWidth+1)
		model := padRight(ansi.Truncate(row.Model, modelWidth, "…"), modelWidth+1)
		line := dot + state.Render(label) + th.Faint.Render(model) + state.Render(status)
		if i == p.cursor {
			line = th.Title.Render("› ") + line
		} else {
			line = "  " + line
		}
		lines = append(lines, mark(m.zones.frame, fmt.Sprintf("provider:%d", i), ansi.Truncate(" "+line, width, "…")))
	}
	if row := p.current(); row != nil {
		lines = append(lines, "", " "+th.Strong.Render(row.Label))
		switch {
		case row.ID == m.session.Info.Provider:
			lines = append(lines, " "+th.Body.Render("This session runs on it ("+m.session.Info.Model+"). enter lists its models, fetched from it."))
		case row.Configured:
			lines = append(lines, " "+th.Body.Render("Ready. enter lists its models (fetched from it) to switch to; d makes it the default for new sessions."))
		case len(row.Login) > 0:
			lines = append(lines, " "+th.Body.Render("Needs "+strings.Join(row.Missing, " and ")+". enter opens "+engineName(*row)+"'s own sign-in in this terminal."))
		default:
			lines = append(lines, " "+th.Body.Render("Needs "+strings.Join(row.Missing, " and ")+". enter asks for it: paste, and its models are fetched."))
		}
		if row.Note != "" {
			lines = append(lines, " "+th.Faint.Render(ansi.Truncate(row.Note, width-2, "…")))
		}
		if row.KeyURL != "" {
			lead := "Get a key: "
			if row.OutsideEngine() {
				lead = "Install " + engineName(*row) + ": "
			}
			lines = append(lines, " "+th.Faint.Render(lead)+th.Highlight.Render(ansi.Truncate(row.KeyURL, width-len(lead)-3, "…")))
		}
	}
	if p.pending != "" {
		lines = append(lines, "", " "+m.spin.View()+th.Faint.Render(" "+p.pending+"…"))
	}
	if p.err != "" {
		lines = append(lines, " "+th.Bad.Render(ansi.Truncate(p.err, width-2, "…")))
	}
	return strings.Join(fitLines(lines, width, height), "\n")
}
