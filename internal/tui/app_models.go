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

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// The model picker: every model of every provider — read live from the providers, OpenRouter's
// whole catalog and every free model included — filtered as you type, with its price. Tab narrows
// it to the free ones or the ones ready to use; a model whose provider has no key yet is shown,
// dimmed, with the key it needs. Choosing one switches the session in place; the conversation
// carries across, exactly as a mode change does.

// pickerViews are the picker's narrowings, in the order tab goes through them.
var pickerViews = []string{"all", "free", "ready"}

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
	rows    listView
	pending bool // a switch is in flight
	narrow  int  // index into pickerViews
}

func (p *modelPicker) title() string { return "Models" }
func (p *modelPicker) key() string   { return "models" }

func (p *modelPicker) wheel(_ *Model, up bool) tea.Cmd {
	p.rows.wheel(up, len(p.shown))
	return nil
}

// click picks a narrowing from the strip, or selects a model; a second click on it switches.
func (p *modelPicker) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	if p.pending {
		return nil
	}
	for i := range pickerViews {
		if m.zones.frame.Get(fmt.Sprintf("modeltab:%d", i)).InBounds(msg) {
			p.narrow, p.rows.cursor = i, 0
			p.refilter()
			return nil
		}
	}
	if i, ok := p.rows.clicked(m.zones.frame, msg, len(p.shown)); ok && p.rows.clickRow(i) {
		_, cmd := p.handle(m, keyPress("enter"))
		return cmd
	}
	return nil
}

// inView is whether a model belongs to the picker's current narrowing.
func (p *modelPicker) inView(c acp.ModelChoice) bool {
	switch pickerViews[p.narrow] {
	case "free":
		return c.Free
	case "ready":
		return !c.Locked
	}
	return true
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
		m.openWindow(picker)
		picker.load(msg)
		return nil
	}
	if picker, ok := windowOf[*modelPicker](m); ok {
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
	var entries []paletteEntry
	for i, c := range p.list.Choices {
		if p.inView(c) {
			label := c.Model + " " + c.ProviderLabel
			if c.Free {
				label += " free"
			}
			entries = append(entries, paletteEntry{label: label, hint: fmt.Sprint(i)})
		}
	}
	p.shown = p.shown[:0]
	for _, e := range rankEntries(entries, p.filter.Value()) {
		var i int
		fmt.Sscan(e.hint, &i)
		p.shown = append(p.shown, p.list.Choices[i])
	}
	p.rows.clamp(len(p.shown))
}

// uniqueModel finds the one model a query names: an exact id, "provider model", or a unique substring.
func uniqueModel(choices []acp.ModelChoice, query string) (acp.ModelChoice, bool) {
	query = strings.ToLower(strings.TrimSpace(query))
	var partial []acp.ModelChoice
	for _, c := range choices {
		if c.Locked {
			continue // not switchable until its provider has a key
		}
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
	if p, ok := windowOf[*modelPicker](m); ok {
		p.pending = false
		if msg.err != nil {
			p.err = msg.err.Error()
			return nil
		}
		m.closeWindow(m.windowIndex(p)) // switched: the window's work is done
	}
	if msg.err != nil {
		return m.toast(toastWarn, "Model not changed: "+msg.err.Error())
	}
	if msg.info.Model != "" {
		msg.info.Root, msg.info.SessionID = m.session.Info.Root, m.session.Info.SessionID
		m.session.Info = msg.info
	}
	if p := m.providersWindow(); p != nil {
		p.pending = ""
	}
	return tea.Batch(m.toast(toastInfo, "Model: "+m.session.Info.Model+" — the conversation carries on"), m.reloadProviders())
}

func (p *modelPicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	if p.pending {
		return msg.String() == "ctrl+c", nil
	}
	switch msg.String() {
	case "esc", "ctrl+c":
		return true, nil
	case "up", "down", "ctrl+k", "ctrl+j", "pgup", "pgdown":
		p.rows.move(msg.String(), len(p.shown)) // letters are the filter's
	case "tab", "shift+tab", "left", "right":
		// ←/→ move between all, free and ready while nothing is typed; with a filter they move
		// in the text, as in any field.
		if (msg.String() == "left" || msg.String() == "right") && p.filter.Value() != "" {
			var cmd tea.Cmd
			p.filter, cmd = p.filter.Update(msg)
			return false, cmd
		}
		step := 1
		if msg.String() == "shift+tab" || msg.String() == "left" {
			step = len(pickerViews) - 1
		}
		p.narrow, p.rows.cursor = (p.narrow+step)%len(pickerViews), 0
		p.refilter()
	case "ctrl+r":
		p.list, p.shown = nil, nil
		return false, m.loadModels(true, "")
	case "enter":
		if len(p.shown) == 0 {
			return false, nil
		}
		choice := p.shown[p.rows.cursor]
		if choice.Locked {
			// A model with no key is one paste away: open that provider's key field.
			if len(choice.Missing) == 1 && m.agent != nil {
				return false, tea.Batch(m.cmdKey(choice.Provider), m.toast(toastInfo, fmt.Sprintf("%s needs %s — paste it, then pick %s again", choice.ProviderLabel, choice.Missing[0], choice.Model)))
			}
			return false, m.toast(toastWarn, fmt.Sprintf("%s needs %s — /settings adds it, then pick %s", choice.ProviderLabel, strings.Join(choice.Missing, " and "), choice.Model))
		}
		p.pending = true
		if warning := fitWarning(choice); warning != "" {
			return false, tea.Batch(m.switchModel(choice), m.toast(toastWarn, warning))
		}
		return false, m.switchModel(choice)
	default:
		var cmd tea.Cmd
		p.filter, cmd = p.filter.Update(msg)
		p.refilter()
		return false, cmd
	}
	return false, nil
}

// tabs is the narrowing strip: each view with how many models it holds, the current one lit.
func (p *modelPicker) tabs(m *Model, width int) string {
	th := m.th
	counts := map[string]int{}
	for _, c := range p.list.Choices {
		counts["all"]++
		if c.Free {
			counts["free"]++
		}
		if !c.Locked {
			counts["ready"]++
		}
	}
	names := map[string]string{"all": "All", "free": "Free", "ready": "Ready to use"}
	var parts []string
	for i, v := range pickerViews {
		label := fmt.Sprintf(" %s %d ", names[v], counts[v])
		if i == p.narrow {
			label = lipgloss.NewStyle().Foreground(th.Bg).Background(th.Primary).Bold(true).Render(label)
		} else {
			label = th.Faint.Render(label)
		}
		parts = append(parts, mark(m.zones.frame, fmt.Sprintf("modeltab:%d", i), label))
	}
	return ansi.Truncate(strings.Join(parts, " "), width, "")
}

func (p *modelPicker) view(m *Model) string {
	th := m.th
	width, height := m.width, max(m.windowHeight(), 1)
	inner := max(width-2, 8)
	p.filter.SetWidth(max(inner-2, 4))
	p.rows.zone = "model"
	lines := []string{" " + p.filter.View()}
	switch {
	case p.list == nil && p.err == "":
		lines = append(lines, " "+m.spin.View()+th.Faint.Render(" asking the agent for models…"))
	case p.list == nil:
		lines = append(lines, " "+th.Bad.Render(ansi.Truncate(p.err, inner, "…")))
	default:
		lines = append(lines, " "+p.tabs(m, inner), "")
		// Price first (it is what decides a switch), then the model name takes what is left.
		priceWidth := min(40, max(inner-2-17-13, 0))
		modelWidth := max(inner-2-17-priceWidth-1, 4)
		extra := 0
		if p.err != "" {
			extra = 1
		}
		from, to := p.rows.window(len(p.shown), max(height-len(lines)-1-extra, 1))
		for i := from; i < to; i++ {
			c := p.shown[i]
			badge := "  "
			switch {
			case c.Model == m.session.Info.Model && c.Provider == m.session.Info.Provider:
				badge = "✓ "
			case c.Locked:
				badge = "· "
			case c.IsDefault:
				badge = "★ "
			}
			name := padRight(ansi.Truncate(c.Model, modelWidth, "…"), modelWidth+1)
			provider := padRight(ansi.Truncate(c.ProviderLabel, 16, "…"), 17)
			priceText := c.Price
			if c.Locked {
				priceText = "needs " + strings.Join(c.Missing, " + ")
			}
			if at, ok := m.limited[c.Model]; ok && time.Since(at) < 2*time.Minute && !c.Locked {
				priceText += " · rate limited"
			}
			if label := rowLabel(c); label != "" && !c.Locked {
				priceText += " · " + label
			}
			price := ansi.Truncate(priceText, priceWidth, "…")
			var row string
			switch {
			case c.Locked:
				row = th.Faint.Render(badge + name + provider + price)
			case c.Free:
				row = th.OK.Render(badge) + th.Body.Render(name) + th.Faint.Render(provider) + th.OK.Render(price)
			default:
				row = th.OK.Render(badge) + th.Body.Render(name) + th.Faint.Render(provider) + th.Highlight.Render(price)
			}
			lines = append(lines, p.rows.row(m, m.zones.frame, i, " "+row, width))
		}
		if len(p.shown) == 0 {
			lines = append(lines, " "+th.Faint.Render("nothing matches"))
		}
		if p.err != "" {
			lines = append(lines, " "+th.Warn.Render(ansi.Truncate(p.err, inner, "…")))
		}
	}
	foot := m.hintBar(width, button{"enter", "switch"}, button{"tab", "all · free · ready"}, button{"ctrl+r", "ask providers again"}, button{"esc", "close"})
	if p.pending {
		foot = " " + m.spin.View() + th.Faint.Render(" switching…")
	}
	return strings.Join(append(fitLines(lines, width, height-1), foot), "\n")
}

// fitLabel is the few words a free model's measured fit adds to its row; a verified or unmeasured
// model adds none. A small model is labelled whether or not it is free.
func fitLabel(c acp.ModelChoice) string {
	switch {
	case c.Fit == "slow":
		return "slow"
	case c.Fit == "busy":
		return "busy"
	case c.Fit == "apps-only":
		return "apps only"
	case c.Small || c.Fit == "small":
		return "small"
	}
	return ""
}

// rowLabel is what a model's row says of its fit: only what stops it working well at all (slow,
// apps only). "small" and "busy" are left to the warning on picking it; on every row they read
// as a verdict on models that mostly answer.
func rowLabel(c acp.ModelChoice) string {
	if label := fitLabel(c); label != "small" && label != "busy" {
		return label
	}
	return ""
}

// fitWarning is what picking a model with a poor fit should say; it is still switched to, because
// the person asked for it and the measurement may be out of date.
func fitWarning(c acp.ModelChoice) string {
	switch fitLabel(c) {
	case "slow":
		return c.Model + " is slow on the free tier (" + c.FitNote + "). Expect long waits; openrouter/free picks a faster one."
	case "busy":
		return c.Model + " is often refused upstream on the free tier (" + c.FitNote + "). Expect rate-limit waits; openrouter/free switches for you."
	case "apps only":
		return c.Model + ": " + c.FitNote + ". Requests will likely fail; openrouter/free picks one that answers."
	case "small":
		return c.Model + " is a small model: fine for chat, but it often misuses tools. Use a larger one for edits."
	}
	return ""
}
