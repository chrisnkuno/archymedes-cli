package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

// The model picker: every model the agent can switch to, filtered as you type, with its price,
// and the providers that still need a key said plainly at the foot. Choosing one switches the
// session in place; the conversation carries across, exactly as a mode change does.

type modelsLoadedMsg struct {
	list  acp.ModelList
	err   error
	query string // `/model <query>` waiting on the list
}

type modelSetMsg struct {
	info acp.SessionInfo
	err  error
}

type modelPicker struct {
	list    *acp.ModelList
	err     string
	filter  textinput.Model
	shown   []acp.ModelChoice
	cursor  int
	pending bool // a switch is in flight
}

func newModelPicker(m *Model, query string) *modelPicker {
	in := textinput.New()
	in.Placeholder = "filter by model or provider"
	in.Prompt = "› "
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Prompt, s.Focused.Text, s.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	in.SetStyles(s)
	in.SetValue(query)
	in.Focus()
	return &modelPicker{filter: in}
}

// loadModels asks the agent for the list; query, when set, is a `/model <query>` to resolve with it.
func (m *Model) loadModels(refresh bool, query string) tea.Cmd {
	agent := m.agent
	if agent == nil {
		return nil
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		list, err := agent.Models(ctx, refresh)
		return modelsLoadedMsg{list, err, query}
	}
}

func (m *Model) modelsLoaded(msg modelsLoadedMsg) tea.Cmd {
	if msg.query != "" && msg.err == nil {
		// `/model <query>`: switch straight away when the query names one model; otherwise open the
		// picker on it, so a near miss becomes a short list rather than an error.
		if choice, ok := uniqueModel(msg.list.Choices, msg.query); ok {
			return m.switchModel(choice)
		}
		picker := newModelPicker(m, msg.query)
		m.openOverlay(picker)
		picker.load(msg)
		return nil
	}
	if picker, ok := m.overlay.(*modelPicker); ok {
		picker.load(msg)
	}
	return nil
}

func (p *modelPicker) load(msg modelsLoadedMsg) {
	if msg.err != nil {
		p.err = msg.err.Error()
		return
	}
	p.list, p.err = &msg.list, strings.Join(msg.list.Errors, "; ")
	p.refilter()
}

func (p *modelPicker) refilter() {
	if p.list == nil {
		return
	}
	entries := make([]paletteEntry, len(p.list.Choices))
	for i, c := range p.list.Choices {
		entries[i] = paletteEntry{label: c.Model + " " + c.ProviderLabel, hint: fmt.Sprint(i)}
	}
	p.shown = p.shown[:0]
	for _, e := range rankEntries(entries, p.filter.Value()) {
		var i int
		fmt.Sscan(e.hint, &i)
		p.shown = append(p.shown, p.list.Choices[i])
	}
	p.cursor = min(p.cursor, max(len(p.shown)-1, 0))
}

// uniqueModel finds the one model a query names: an exact id, "provider model", or a unique substring.
func uniqueModel(choices []acp.ModelChoice, query string) (acp.ModelChoice, bool) {
	query = strings.ToLower(strings.TrimSpace(query))
	var partial []acp.ModelChoice
	for _, c := range choices {
		id := strings.ToLower(c.Model)
		if id == query || strings.ToLower(c.Provider+" "+c.Model) == query || strings.ToLower(c.Provider+":"+c.Model) == query {
			return c, true
		}
		if strings.Contains(id, query) {
			partial = append(partial, c)
		}
	}
	if len(partial) == 1 {
		return partial[0], true
	}
	return acp.ModelChoice{}, false
}

func (m *Model) switchModel(choice acp.ModelChoice) tea.Cmd {
	if m.phase == busy {
		return m.toast(toastWarn, "Switch models between turns; esc stops this one")
	}
	agent, id := m.agent, m.session.ID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		info, err := agent.SetModel(ctx, id, choice.Provider, choice.Model)
		return modelSetMsg{info, err}
	}
}

func (m *Model) modelSet(msg modelSetMsg) tea.Cmd {
	if p, ok := m.overlay.(*modelPicker); ok {
		p.pending = false
		if msg.err != nil {
			p.err = msg.err.Error()
			return nil
		}
		m.overlay = nil
	}
	if msg.err != nil {
		return m.toast(toastWarn, "Model not changed: "+msg.err.Error())
	}
	if msg.info.Model != "" {
		msg.info.Root, msg.info.SessionID = m.session.Info.Root, m.session.Info.SessionID
		m.session.Info = msg.info
	}
	return m.toast(toastInfo, "Model: "+m.session.Info.Model+" — the conversation carries on")
}

func (p *modelPicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	if p.pending {
		return msg.String() == "ctrl+c", nil
	}
	switch msg.String() {
	case "esc", "ctrl+c":
		return true, nil
	case "up", "ctrl+k":
		p.cursor = (p.cursor - 1 + max(len(p.shown), 1)) % max(len(p.shown), 1)
	case "down", "ctrl+j", "tab":
		p.cursor = (p.cursor + 1) % max(len(p.shown), 1)
	case "ctrl+r":
		p.list, p.shown = nil, nil
		return false, m.loadModels(true, "")
	case "enter":
		if len(p.shown) == 0 {
			return false, nil
		}
		p.pending = true
		return false, m.switchModel(p.shown[p.cursor])
	default:
		var cmd tea.Cmd
		p.filter, cmd = p.filter.Update(msg)
		p.refilter()
		return false, cmd
	}
	return false, nil
}

func (p *modelPicker) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 84)
	inner := max(width-4, 8)
	p.filter.SetWidth(max(inner-2, 4))
	var b strings.Builder
	b.WriteString(p.filter.View() + "\n")
	switch {
	case p.list == nil && p.err == "":
		b.WriteString(m.spin.View() + th.Faint.Render(" asking the agent for models…") + "\n")
	case p.list == nil:
		b.WriteString(th.Bad.Render(ansi.Wrap(p.err, inner, "")) + "\n")
	default:
		rows := min(len(p.shown), max(m.transcriptHeight()-8, 3))
		start := max(0, min(p.cursor-rows+1, len(p.shown)-rows))
		// Price first (it is what decides a switch), then the model name takes what is left.
		priceWidth := min(30, max(inner-2-17-13, 0))
		modelWidth := max(inner-2-17-priceWidth-1, 4)
		for i := start; i < start+rows && i < len(p.shown); i++ {
			c := p.shown[i]
			mark := "  "
			switch {
			case c.Model == m.session.Info.Model && c.Provider == m.session.Info.Provider:
				mark = "✓ "
			case c.IsDefault:
				mark = "★ "
			}
			name := padRight(ansi.Truncate(c.Model, modelWidth, "…"), modelWidth+1)
			provider := padRight(ansi.Truncate(c.ProviderLabel, 16, "…"), 17)
			price := ansi.Truncate(c.Price, priceWidth, "…")
			if i == p.cursor {
				line := padRight(mark+name+provider+price, inner)
				b.WriteString(lipgloss.NewStyle().Foreground(th.Text).Background(th.Tint(th.Primary, 0.3)).Bold(true).Render(ansi.Truncate(line, inner, "")))
			} else {
				b.WriteString(th.OK.Render(mark) + th.Body.Render(name) + th.Faint.Render(provider) + th.Highlight.Render(price))
			}
			b.WriteString("\n")
		}
		if len(p.shown) == 0 {
			b.WriteString(th.Faint.Render("nothing matches") + "\n")
		}
		for i, u := range p.list.Unconfigured {
			if i == 2 {
				b.WriteString(th.Faint.Render(fmt.Sprintf("  …and %d more providers without a key", len(p.list.Unconfigured)-2)) + "\n")
				break
			}
			b.WriteString(th.Faint.Render(ansi.Truncate(fmt.Sprintf("  %s needs %s", u.Label, strings.Join(u.Missing, " and ")), inner, "…")) + "\n")
		}
		if p.err != "" {
			b.WriteString(th.Warn.Render(ansi.Truncate(p.err, inner, "…")) + "\n")
		}
	}
	footer := "enter switch · ctrl+r ask providers again · esc close"
	if p.pending {
		footer = m.spin.View() + " switching…"
	}
	b.WriteString(th.Faint.Render(ansi.Truncate(footer, inner, "")))
	return frame(th, "Model", b.String(), width)
}
