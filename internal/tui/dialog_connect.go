package tui

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/gallery"
)

// The Connect dialog: one flow for setting up and switching providers, used on first run, from the
// Providers app and by /key. Three steps, each skipped when it has nothing to ask:
//
//  1. choose a provider;
//  2. fill in what it needs (its key, a base URL when it has one), pasted or typed, all in one form;
//  3. pick one of its models, fetched from the provider as part of connecting — nobody types a model
//     name or refreshes a list. Enter takes the one preselected (the provider's current model).
//
// Connecting is checking: the agent asks the provider for its models with what was filled in, so a
// refused key is caught before anything is saved.

type connectStep int

const (
	stepChoose connectStep = iota
	stepForm
	stepWorking // checking the provider, or fetching its models
	stepModels
)

type connectDialog struct {
	firstRun  bool   // no session yet: picking a model makes this provider the default and opens one
	reason    string // why first run is asking
	step      connectStep
	providers []acp.ProviderOverview
	loaded    bool
	cursor    int
	fromList  bool // esc on the form goes back to the list
	provider  acp.ProviderOverview
	inputs    []textinput.Model
	focus     int
	working   string
	models    []string
	shown     []string
	filter    textinput.Model
	mcursor   int
	err       string
	errField  string
	note      string
}

type connectProvidersMsg struct {
	rows []acp.ProviderOverview
	err  error
	// then: what to do once loaded — open this provider's form ("form") or its models ("models").
	provider, then string
}

type connectResultMsg struct {
	result acp.ConnectResult
	err    error
}

type connectModelsMsg struct {
	models  []string
	listErr string
	err     error
}

type firstRunReadyMsg struct{ err error }

// signedInMsg: the provider's own sign-in (run in the terminal) has finished.
type signedInMsg struct{ err error }

func newConnectDialog(m *Model) *connectDialog {
	f := textinput.New()
	f.Prompt = "› "
	f.Placeholder = "type to filter, or a model name"
	m.styleInput(&f)
	return &connectDialog{filter: f}
}

func (m *Model) styleInput(in *textinput.Model) {
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Prompt, s.Focused.Text, s.Focused.Placeholder = m.th.Title, m.th.Body, m.th.Faint
	s.Blurred.Prompt, s.Blurred.Text, s.Blurred.Placeholder = m.th.Faint, m.th.Body, m.th.Faint
	in.SetStyles(s)
}

// openConnect opens the dialog. provider "" starts at the list; then is "form" or "models" for a
// named provider: set it up (or change its key and URL), or go straight to picking among its models.
func (m *Model) openConnect(provider, then string) tea.Cmd {
	if m.agent == nil {
		return m.toast(toastWarn, "The agent is still starting; try again in a moment")
	}
	d := newConnectDialog(m)
	m.openOverlay(d)
	return m.loadConnectProviders(provider, then)
}

// openFirstRun is the dialog as the first thing anyone sees: nothing to talk to until it is done.
func (m *Model) openFirstRun(status acp.SetupStatus) tea.Cmd {
	d := newConnectDialog(m)
	d.firstRun, d.reason = true, status.Reason
	m.openOverlay(d)
	return m.loadConnectProviders("", "")
}

func (m *Model) loadConnectProviders(provider, then string) tea.Cmd {
	agent := m.agent
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		rows, err := agent.Providers(ctx)
		return connectProvidersMsg{rows: rows, err: err, provider: provider, then: then}
	}
}

func (m *Model) connectDialog() *connectDialog {
	d, _ := m.overlay.(*connectDialog)
	return d
}

func (m *Model) connectProvidersLoaded(msg connectProvidersMsg) tea.Cmd {
	d := m.connectDialog()
	if d == nil {
		return nil
	}
	d.loaded = true
	if msg.err != nil {
		d.err = msg.err.Error()
		return nil
	}
	d.providers = msg.rows
	want := strings.ToLower(strings.TrimSpace(msg.provider))
	for i, row := range d.providers {
		if want != "" && (row.ID == want || strings.Contains(strings.ToLower(row.Label), want)) {
			d.cursor = i
			return d.selectProvider(m, row, msg.then)
		}
	}
	if msg.provider != "" {
		d.err = "No provider " + msg.provider
	}
	return nil
}

// selectProvider moves on from the list: to the form, or straight to the models when there is
// nothing to fill in (a configured provider being used, or one like Ollama that needs nothing).
func (d *connectDialog) selectProvider(m *Model, row acp.ProviderOverview, then string) tea.Cmd {
	d.provider, d.err, d.errField, d.note = row, "", "", ""
	if then == "models" || (then == "" && row.Configured && (len(row.Fields) == 0 || d.firstRun)) {
		return d.fetchModels(m)
	}
	return d.openForm(m)
}

func (d *connectDialog) openForm(m *Model) tea.Cmd {
	d.step, d.focus = stepForm, 0
	d.inputs = d.inputs[:0]
	for _, field := range d.provider.Fields {
		in := textinput.New()
		in.Prompt = "› "
		m.styleInput(&in)
		switch field.Kind {
		case "secret":
			in.EchoMode, in.EchoCharacter = textinput.EchoPassword, '•'
			in.Placeholder = "paste the key"
			if field.IsSet {
				in.Placeholder = "saved (" + field.Value + ") — leave empty to keep it"
			}
		case "url":
			in.SetValue(field.Value)
			in.Placeholder = field.Placeholder + " (the default when empty)"
		default:
			in.SetValue(field.Value)
		}
		d.inputs = append(d.inputs, in)
	}
	// Start on the first field that still needs something.
	for i, field := range d.provider.Fields {
		if field.Required && !field.IsSet {
			d.focus = i
			break
		}
	}
	return d.focusInput()
}

func (d *connectDialog) focusInput() tea.Cmd {
	var cmd tea.Cmd
	for i := range d.inputs {
		if i == d.focus {
			cmd = d.inputs[i].Focus()
		} else {
			d.inputs[i].Blur()
		}
	}
	return cmd
}

// nextMissing is the first required field that is neither typed in nor already saved; -1 when none.
func (d *connectDialog) nextMissing() int {
	for i, field := range d.provider.Fields {
		if field.Required && !field.IsSet && strings.TrimSpace(d.inputs[i].Value()) == "" {
			return i
		}
	}
	return -1
}

// submit sends what was filled in: a secret only when something was typed (empty keeps the saved
// one), a URL always (empty puts the default back).
func (d *connectDialog) submit(m *Model) tea.Cmd {
	values := map[string]string{}
	for i, field := range d.provider.Fields {
		value := strings.TrimSpace(d.inputs[i].Value())
		if field.Kind == "secret" {
			value = cleanKey(value)
			if value == "" {
				continue
			}
		}
		values[field.Key] = value
	}
	d.step, d.working, d.err, d.errField, d.note = stepWorking, "checking with "+d.provider.Label, "", "", ""
	switch d.provider.ID {
	case "claude":
		d.working = "checking Claude Code (and installing Anthropic's Agent SDK the first time)"
	case "codex":
		d.working = "checking Codex and its sign-in"
	}
	agent, id := m.agent, d.provider.ID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, err := agent.ConnectProvider(ctx, id, values)
		return connectResultMsg{result, err}
	}
}

func (m *Model) connectResult(msg connectResultMsg) tea.Cmd {
	d := m.connectDialog()
	if d == nil {
		return nil
	}
	switch {
	case msg.err != nil:
		d.step, d.err = stepForm, msg.err.Error()
		return d.focusInput()
	case !msg.result.OK:
		d.step, d.err, d.errField = stepForm, msg.result.Error, msg.result.Field
		for i, field := range d.provider.Fields {
			if field.Key == msg.result.Field {
				d.focus = i
			}
		}
		return d.focusInput()
	}
	d.provider.Configured, d.note = true, msg.result.Note
	return tea.Batch(d.showModels(m, msg.result.Models), m.reloadProviders())
}

// signIn hands the terminal to the provider's own sign-in (Claude Code's `claude auth login`) and
// connects when it returns. Archymedes only waits: the account is between the person and Anthropic.
func (d *connectDialog) signIn() tea.Cmd {
	d.step, d.working, d.err = stepWorking, "signing in, in "+engineName(d.provider), ""
	cmd := exec.Command(d.provider.Login[0], d.provider.Login[1:]...)
	return tea.ExecProcess(cmd, func(err error) tea.Msg { return signedInMsg{err} })
}

func (m *Model) signedIn(msg signedInMsg) tea.Cmd {
	d := m.connectDialog()
	if d == nil {
		return m.reloadProviders()
	}
	if msg.err != nil {
		d.step, d.err = stepForm, "Sign-in did not finish: "+msg.err.Error()
		return nil
	}
	d.provider.Login = nil // signed in, as far as we know: connecting checks
	return d.submit(m)
}

func (d *connectDialog) fetchModels(m *Model) tea.Cmd {
	d.step, d.working = stepWorking, "asking "+d.provider.Label+" for its models"
	agent, id := m.agent, d.provider.ID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		models, listErr, err := agent.ProviderModels(ctx, id)
		return connectModelsMsg{models, listErr, err}
	}
}

func (m *Model) connectModels(msg connectModelsMsg) tea.Cmd {
	d := m.connectDialog()
	if d == nil {
		return nil
	}
	switch {
	case msg.err != nil:
		d.note = "Could not ask for its models: " + msg.err.Error()
	case len(msg.models) == 0 && msg.listErr != "":
		d.note = "It did not list its models (" + msg.listErr + "); type one, or enter keeps " + d.provider.Model
	}
	return d.showModels(m, msg.models)
}

// showModels is the last step. The provider's current model is preselected, so enter alone keeps it.
func (d *connectDialog) showModels(m *Model, models []string) tea.Cmd {
	d.step, d.models = stepModels, models
	d.filter.Reset()
	d.refilter()
	for i, name := range d.shown {
		if name == d.provider.Model {
			d.mcursor = i
		}
	}
	return d.filter.Focus()
}

func (d *connectDialog) refilter() {
	needle := strings.ToLower(strings.TrimSpace(d.filter.Value()))
	d.shown = d.shown[:0]
	for _, name := range d.models {
		if needle == "" || strings.Contains(strings.ToLower(name), needle) {
			d.shown = append(d.shown, name)
		}
	}
	d.mcursor = min(d.mcursor, max(len(d.shown)-1, 0))
}

// pick finishes: the chosen model is remembered for the provider, and the session moves to it — or,
// on first run, the provider becomes the default and the session opens on it.
func (d *connectDialog) pick(m *Model) tea.Cmd {
	model := d.provider.Model
	switch {
	case len(d.shown) > 0:
		model = d.shown[d.mcursor]
	case strings.TrimSpace(d.filter.Value()) != "":
		model = strings.TrimSpace(d.filter.Value())
	}
	agent, provider := m.agent, d.provider
	m.overlay = nil
	if d.firstRun || m.session.ID == "" {
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if _, err := agent.SetSetting(ctx, "ARCHYMEDES_PROVIDER", provider.ID); err != nil {
				return firstRunReadyMsg{err}
			}
			return firstRunReadyMsg{agent.RememberModel(ctx, provider.ID, model)}
		}
	}
	remember := func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = agent.RememberModel(ctx, provider.ID, model) // a convenience: the switch below is what matters
		return nil
	}
	return tea.Batch(remember, m.switchModel(acp.ModelChoice{Provider: provider.ID, ProviderLabel: provider.Label, Model: model}))
}

func (m *Model) firstRunReady(msg firstRunReadyMsg) tea.Cmd {
	if msg.err != nil {
		return m.toast(toastWarn, "Saved the key, but not the choice: "+msg.err.Error())
	}
	return m.openSession()
}

func (d *connectDialog) leave(m *Model) (bool, tea.Cmd) {
	if d.firstRun {
		return true, m.quit() // nothing to talk to without a provider
	}
	return true, nil
}

func (d *connectDialog) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	key := msg.String()
	if key == "ctrl+c" {
		return d.leave(m)
	}
	switch d.step {
	case stepWorking:
		return false, nil
	case stepChoose:
		switch key {
		case "esc":
			return d.leave(m)
		case "up", "k", "shift+tab":
			d.cursor = (d.cursor - 1 + max(len(d.providers), 1)) % max(len(d.providers), 1)
		case "down", "j", "tab":
			d.cursor = (d.cursor + 1) % max(len(d.providers), 1)
		case "enter":
			if len(d.providers) > 0 {
				d.fromList = true
				return false, d.selectProvider(m, d.providers[d.cursor], "")
			}
		}
		return false, nil
	case stepForm:
		switch key {
		case "esc":
			if d.fromList {
				d.step, d.err = stepChoose, ""
				return false, nil
			}
			return d.leave(m)
		case "tab", "down":
			d.focus = (d.focus + 1) % max(len(d.inputs), 1)
			return false, d.focusInput()
		case "shift+tab", "up":
			d.focus = (d.focus - 1 + max(len(d.inputs), 1)) % max(len(d.inputs), 1)
			return false, d.focusInput()
		case "ctrl+s":
			return false, d.submit(m)
		case "enter":
			// A provider signed in to elsewhere (Claude, in Claude Code) signs in first, then connects.
			if len(d.provider.Login) > 0 && !d.provider.Configured {
				return false, d.signIn()
			}
			// Connect as soon as everything required is there (paste a key, enter); otherwise go to
			// what is still missing.
			if next := d.nextMissing(); next >= 0 {
				d.focus = next
				return false, d.focusInput()
			}
			return false, d.submit(m)
		}
		if len(d.inputs) == 0 {
			return false, nil
		}
		var cmd tea.Cmd
		d.inputs[d.focus], cmd = d.inputs[d.focus].Update(msg)
		return false, cmd
	case stepModels:
		switch key {
		case "esc":
			return d.leave(m)
		case "up", "ctrl+k":
			d.mcursor = max(d.mcursor-1, 0)
			return false, nil
		case "down", "ctrl+j":
			d.mcursor = min(d.mcursor+1, max(len(d.shown)-1, 0))
			return false, nil
		case "enter":
			return true, d.pick(m)
		case "ctrl+e":
			return false, d.openForm(m) // change the key or URL after all
		}
		var cmd tea.Cmd
		d.filter, cmd = d.filter.Update(msg)
		d.refilter()
		return false, cmd
	}
	return false, nil
}

// paste goes where typing would: the focused field (a key cleaned of `NAME=` and quotes), or the
// model filter; on the list it opens the highlighted provider's form with the key in it.
func (d *connectDialog) paste(m *Model, text string) tea.Cmd {
	switch d.step {
	case stepChoose:
		if len(d.providers) == 0 {
			return nil
		}
		d.fromList = true
		d.provider = d.providers[d.cursor]
		cmd := d.openForm(m)
		for i, field := range d.provider.Fields {
			if field.Kind == "secret" {
				d.focus = i
				d.inputs[i].SetValue(cleanKey(text))
				return tea.Batch(cmd, d.focusInput())
			}
		}
		return cmd
	case stepForm:
		if len(d.inputs) == 0 {
			return nil
		}
		value := strings.TrimSpace(strings.ReplaceAll(text, "\n", " "))
		if d.provider.Fields[d.focus].Kind == "secret" {
			value = cleanKey(text)
		}
		d.inputs[d.focus].SetValue(value)
		d.inputs[d.focus].CursorEnd()
	case stepModels:
		cmd := pasteInto(&d.filter, text)
		d.refilter()
		return cmd
	}
	return nil
}

// Rows are clickable on the list and the model steps.
func (d *connectDialog) rowCount() int {
	switch d.step {
	case stepChoose:
		return len(d.providers)
	case stepModels:
		return min(len(d.shown), connectModelRows)
	}
	return 0
}

// choose is a click on row i of the list or the models: the first selects it, a second goes on.
func (d *connectDialog) choose(m *Model, i int) tea.Cmd {
	switch d.step {
	case stepChoose:
		if i < len(d.providers) {
			if d.cursor != i {
				d.cursor = i
				return nil
			}
			d.fromList = true
			return d.selectProvider(m, d.providers[i], "")
		}
	case stepModels:
		start := max(0, min(d.mcursor-connectModelRows/2, len(d.shown)-connectModelRows))
		if start+i < len(d.shown) {
			if d.mcursor != start+i {
				d.mcursor = start + i
				return nil
			}
			return d.pick(m)
		}
	}
	return nil
}

// click puts the cursor in the field clicked; the rows are rowPicker's.
func (d *connectDialog) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	if d.step == stepForm {
		for i := range d.inputs {
			if m.zones.dialog.Get(fmt.Sprintf("field:%d", i)).InBounds(msg) {
				d.focus = i
				return d.focusInput()
			}
		}
		return nil
	}
	for i := range d.rowCount() {
		if m.zones.dialog.Get(rowID(i)).InBounds(msg) {
			return d.choose(m, i)
		}
	}
	return nil
}

// wheel moves through the providers or the models.
func (d *connectDialog) wheel(m *Model, up bool) tea.Cmd {
	if d.step == stepChoose || d.step == stepModels {
		_, cmd := d.handle(m, keyPress(map[bool]string{true: "up", false: "down"}[up]))
		return cmd
	}
	return nil
}

const connectModelRows = 10

func (d *connectDialog) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 78)
	inner := max(width-4, 8)
	var photo []string
	const photoCols, photoRows = 18, 8
	if d.firstRun && d.step == stepChoose && inner >= 62 {
		photo = m.photoCard(gallery.OfTheme("greek", 0), photoCols, photoRows)
	}
	if photo != nil {
		inner -= photoCols + 3
	}
	var b strings.Builder
	switch d.step {
	case stepChoose:
		intro := "Connect a provider. Pick one; you paste its key (and a base URL if it has one), and its models are fetched for you."
		if d.firstRun {
			intro = "First, a model to work with. Pick a provider and paste its key; it is checked with the provider, and its models are fetched for you."
		}
		b.WriteString(th.Body.Render(ansi.Wrap(intro, inner, "")) + "\n\n")
		switch {
		case !d.loaded:
			b.WriteString(m.spin.View() + th.Faint.Render(" asking the agent…"))
		case len(d.providers) == 0:
			b.WriteString(th.Warn.Render(ansi.Wrap(firstNonEmpty(d.err, d.reason, "No providers."), inner, "")))
		default:
			for i, p := range d.providers {
				label := padRight(ansi.Truncate(p.Label, 26, "…"), 27)
				hint := connectHint(p)
				hint = ansi.Truncate(hint, max(inner-29, 0), "…")
				row := th.Body.Render("  "+label) + th.Faint.Render(hint)
				if i == d.cursor {
					row = th.Title.Render("› "+label) + th.Highlight.Render(hint)
				}
				b.WriteString(mark(m.zones.dialog, rowID(i), row) + "\n")
			}
			leave := "esc close"
			if d.firstRun {
				leave = "esc quit"
			}
			b.WriteString("\n" + m.dialogHintBar(inner, button{"enter", "choose"}, button{"esc", strings.TrimPrefix(leave, "esc ")}) + th.Faint.Render(" · or paste a key"))
		}
	case stepForm:
		p := d.provider
		b.WriteString(th.Strong.Render(p.Label) + "\n")
		if p.KeyURL != "" {
			b.WriteString(th.Faint.Render("Get a key: ") + th.Highlight.Hyperlink(p.KeyURL).Render(ansi.Truncate(p.KeyURL, inner-11, "…")) + "\n")
		}
		for i, field := range p.Fields {
			label := field.Label
			if field.Required {
				label += th.Faint.Render("  required")
			}
			b.WriteString("\n" + th.Body.Render(ansi.Truncate(label, inner, "…")) + "\n")
			d.inputs[i].SetWidth(max(inner-4, 4))
			b.WriteString(mark(m.zones.dialog, fmt.Sprintf("field:%d", i), d.inputs[i].View()) + "\n")
			if d.errField == field.Key && d.err != "" {
				b.WriteString(th.Bad.Render(ansi.Wrap(d.err, inner, "")) + "\n")
			}
		}
		switch {
		case p.OutsideEngine():
			about := p.About
			if about == "" {
				about = "Runs your own Claude Code on your Claude plan. Signing in is Claude Code's own; Friday never sees your account."
			}
			b.WriteString("\n" + th.Body.Render(ansi.Wrap(about, inner, "")) + "\n")
			if len(p.Login) > 0 && !p.Configured {
				b.WriteString("\n" + th.Highlight.Render("enter signs in") + th.Faint.Render(" — "+engineName(p)+"'s sign-in opens in this terminal, then you are back here.") + "\n")
			} else if !p.Configured {
				b.WriteString("\n" + th.Faint.Render(ansi.Wrap("enter connects: "+strings.Join(p.Missing, ", "), inner, "")) + "\n")
			}
		case len(p.Fields) == 0:
			b.WriteString("\n" + th.Faint.Render("Nothing to fill in.") + "\n")
		}
		if p.Note != "" {
			b.WriteString(th.Faint.Render(ansi.Wrap(p.Note, inner, "")) + "\n")
		}
		if d.err != "" && d.errField == "" {
			b.WriteString("\n" + th.Bad.Render(ansi.Wrap(d.err, inner, "")) + "\n")
		}
		b.WriteString("\n" + m.dialogHintBar(inner, button{"enter", "connect"}, button{"tab", "next field"}, button{"esc", "back"}))
	case stepWorking:
		b.WriteString(th.Strong.Render(d.provider.Label) + "\n\n" + m.spin.View() + th.Faint.Render(" "+d.working+"…"))
	case stepModels:
		b.WriteString(th.Strong.Render(d.provider.Label) + th.Faint.Render(fmt.Sprintf("  %d models", len(d.models))) + "\n")
		if d.note != "" {
			b.WriteString(th.Warn.Render(ansi.Wrap(d.note, inner, "")) + "\n")
		}
		d.filter.SetWidth(max(inner-4, 4))
		b.WriteString("\n" + d.filter.View() + "\n")
		start := max(0, min(d.mcursor-connectModelRows/2, len(d.shown)-connectModelRows))
		for i := start; i < min(start+connectModelRows, len(d.shown)); i++ {
			name := ansi.Truncate(d.shown[i], inner-4, "…")
			current := ""
			if d.shown[i] == d.provider.Model {
				current = th.Faint.Render("  current")
			}
			row := th.Body.Render("  "+name) + current
			if i == d.mcursor {
				row = th.Title.Render("› "+name) + current
			}
			b.WriteString(mark(m.zones.dialog, rowID(i-start), row) + "\n")
		}
		if len(d.shown) == 0 {
			hint := "enter keeps " + d.provider.Model
			if strings.TrimSpace(d.filter.Value()) != "" {
				hint = "enter uses " + strings.TrimSpace(d.filter.Value())
			}
			b.WriteString(th.Faint.Render(hint) + "\n")
		}
		b.WriteString("\n" + m.dialogHintBar(inner, button{"enter", "use"}, button{"ctrl+e", "change key or URL"}, button{"esc", "close"}))
	}
	body := b.String()
	if photo != nil {
		body = lipgloss.JoinHorizontal(lipgloss.Top, strings.Join(photo, "\n"), "   ", body)
	}
	title := "Connect a provider"
	if d.firstRun {
		title = "Welcome to Friday"
	}
	return frame(th, title, body, width)
}

// connectHint is what a provider row says beside its name.
func connectHint(p acp.ProviderOverview) string {
	switch {
	case p.Configured:
		return "ready · " + p.Model
	case p.ID == "free":
		return "no paid account needed"
	case len(p.Login) > 0 && p.ID == "codex":
		return "sign in with ChatGPT"
	case len(p.Login) > 0:
		return "sign in with Claude"
	case len(p.Missing) == 1:
		return "needs a key"
	}
	return "needs " + strings.Join(p.Missing, ", ")
}

// cmdKey is /key [provider]: the Connect dialog, on that provider's form when one is named.
func (m *Model) cmdKey(arg string) tea.Cmd {
	return m.openConnect(arg, "form")
}

// engineName is what an outside engine is called in a sentence.
func engineName(p acp.ProviderOverview) string {
	if p.ID == "codex" {
		return "Codex"
	}
	return "Claude Code"
}
