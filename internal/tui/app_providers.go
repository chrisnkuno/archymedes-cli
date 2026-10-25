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
	pending string   // what is in flight, shown while it is
	grid    tileGrid // the providers as tiles; its cursor is cursor
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
		return m.toast(toastWarn, "The agent is still starting; try again in a moment")
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
	case "up", "k", "down", "j", "left", "h", "right", "l", "home", "end", "pgup", "pgdown":
		p.grid.cursor = p.cursor
		p.grid.move(msg.String(), 1)
		p.cursor = p.grid.cursor
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
	if i, ok := p.grid.clicked(m, msg); ok {
		p.cursor = i
	}
	return nil
}

// tiles is each provider as a tile: whether it runs this session, is ready or needs something,
// and the model it would use.
func (p *providersApp) tiles(m *Model) []tile {
	th := m.th
	var out []tile
	for _, row := range p.rows {
		// The full name of what it needs is under the grid; a tile says which kind.
		symbol, tint, status := "○", th.Muted, "needs set-up"
		switch {
		case len(row.Login) > 0:
			status = "needs sign-in"
		case row.KeyVariable != "":
			status = "needs a key"
		}
		switch {
		case row.ID == m.session.Info.Provider:
			symbol, tint, status = "●", th.Success, "in use"
		case row.Configured:
			symbol, tint, status = "✓", th.Success, "ready"
		}
		if row.IsDefault {
			status += " · default"
		}
		lines := append(wrapTo(status, tileArtCols, 2), row.Model)
		out = append(out, tile{id: row.ID, caption: row.Label, art: iconArt(symbol, tint, lines...)})
	}
	return out
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
	lines := []string{" " + head, " " + th.Faint.Render("↑↓←→ move · enter connect or pick a model · e key & URL · d make default · r refresh · esc close")}
	switch {
	case !p.loaded:
		lines = append(lines, "", " "+m.spin.View()+th.Faint.Render(" asking the agent…"))
		return strings.Join(fitLines(lines, width, height), "\n")
	case p.err != "" && len(p.rows) == 0:
		lines = append(lines, "", " "+th.Bad.Render(ansi.Truncate(p.err, width-2, "…")))
		return strings.Join(fitLines(lines, width, height), "\n")
	}
	p.current()
	p.grid.tiles, p.grid.cursor, p.grid.inWindow = p.tiles(m), p.cursor, true
	// The grid gets what the description under it leaves.
	grid := p.grid.view(m, max(width-2, 1), max(height-len(lines)-8, 1))
	for _, line := range strings.Split(grid, "\n") {
		lines = append(lines, " "+line)
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
