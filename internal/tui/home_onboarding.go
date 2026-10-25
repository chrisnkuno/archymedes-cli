package tui

import (
	"cmp"
	"context"
	"errors"
	"maps"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/paginator"
	"charm.land/bubbles/v2/progress"
	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/render"
	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// Onboarding: the first time Friday opens, six short steps before the home screen. Each step is
// one decision or one thing to learn, shown rather than listed: hello (and a name, kept on this
// machine), the look (theme tiles, previewed as you move), the mode (four tiles), the keys (press
// each to try it), the connection (and whether installs are counted), and a first request to
// start from. enter goes on, backspace goes back, esc keeps what is chosen and skips the rest.
// /welcome runs it again. The agent starts behind it; a missing provider waits for the end, where
// the connect dialog takes over.

type onboardStep int

const (
	obHello onboardStep = iota
	obLook
	obMode
	obKeys
	obConnect
	obStart
	obSteps
)

var onboardTitles = [obSteps]string{"Hello", "Look", "Mode", "Keys", "Connect", "Start"}

// keyLesson is one key on the Keys step: the action it runs, what it is for, and whether it was
// pressed here.
type keyLesson struct {
	binding func(k keyMap) key.Binding
	symbol  string
	does    string
	tried   bool
}

type onboarding struct {
	step onboardStep
	bar  progress.Model
	dots paginator.Model

	name      *huh.Input
	nameValue string
	count     *huh.Confirm
	counted   bool // the install count's setting when onboarding opened
	countOn   bool

	themes       tileGrid
	themeAtStart string
	modes        tileGrid
	keys         tileGrid
	lessons      []keyLesson
	starts       tileGrid

	// setup is the agent's word that no provider is ready yet: the connect dialog follows the end.
	setup *acp.SetupStatus
}

// firstRunState is what the walkthrough leaves for later: the name the greeting uses, and what it
// chose before the agent or the session was there to take it.
type firstRunState struct {
	name     string
	mode     string
	settings map[string]string
}

// beginFirstRun reads the name for the greeting and, on a first run, opens the walkthrough.
func (m *Model) beginFirstRun(state config.State) {
	m.firstRun.name = state.Name
	if shouldOnboard(m.opts, state) {
		m.overlay = newOnboarding(m)
	}
}

// shouldOnboard is a first run with somewhere to remember it: never in a one-shot prompt.
func shouldOnboard(opts Options, state config.State) bool {
	return opts.ConfigDir != "" && !state.Onboarded && !state.Welcomed && opts.Prompt == ""
}

func newOnboarding(m *Model) *onboarding {
	ob := &onboarding{themeAtStart: m.th.Name}
	ob.bar = progress.New(progress.WithColors(m.th.Primary, m.th.Secondary), progress.WithoutPercentage(),
		progress.WithFillCharacters('━', '─'), progress.WithSpringOptions(12, 0.9))
	ob.dots = paginator.New(paginator.WithTotalPages(int(obSteps)))
	ob.dots.Type = paginator.Dots
	ob.dots.ActiveDot = lipgloss.NewStyle().Foreground(m.th.Primary).Render("●")
	ob.dots.InactiveDot = m.th.Faint.Render("○")

	ob.nameValue = config.LoadState(m.opts.ConfigDir).Name
	ob.name = huh.NewInput().Title("What should Friday call you?").
		Description("Optional. Kept on this machine, for the greeting; never sent anywhere.").
		Placeholder("your name").CharLimit(40).Value(&ob.nameValue)
	ob.counted = !strings.EqualFold(config.Setting(m.opts.ConfigDir, "ARCHYMEDES_TELEMETRY"), "off") && os.Getenv("DO_NOT_TRACK") == ""
	ob.countOn = ob.counted
	ob.count = huh.NewConfirm().Title("Count installs and updates anonymously?").
		Description("One cue per new version: the version and the OS. Nothing about you or your code.").
		Affirmative("Count").Negative("Don't").Value(&ob.countOn)

	for _, name := range theme.Names() {
		ob.themes.tiles = append(ob.themes.tiles, tile{id: name, caption: name, art: themeArt(name)})
	}
	ob.themes.cursor = max(slices.Index(theme.Names(), m.th.Name), 0)

	for i, mt := range modeTiles {
		ob.modes.tiles = append(ob.modes.tiles, tile{id: mt.name, caption: mt.name,
			art: iconArt(mt.symbol, m.th.ModeColor(mt.name), wrapTo(mt.does, tileArtCols, 3)...)})
		if mt.name == m.mode {
			ob.modes.cursor = i
		}
	}

	ob.lessons = []keyLesson{
		{binding: func(k keyMap) key.Binding { return k.Start }, symbol: "⌕", does: "find any app, command or file"},
		{binding: func(k keyMap) key.Binding { return k.Mode }, symbol: "◎", does: "change the mode"},
		{binding: func(k keyMap) key.Binding { return k.Changes }, symbol: "±", does: "see what changed"},
		{binding: func(k keyMap) key.Binding { return k.Help }, symbol: "?", does: "every key and command"},
	}
	ob.relabelKeys(m)

	for _, s := range m.starters() {
		ob.starts.tiles = append(ob.starts.tiles, tile{id: s, caption: "ask", art: iconArt("›", m.th.Accent, wrapTo(s, tileArtCols, 4)...)})
	}
	ob.starts.tiles = append(ob.starts.tiles, tile{id: "", caption: "look around", art: iconArt("◇", m.th.Secondary, "the home", "screen first")})
	ob.applyTheme(m)
	return ob
}

// openOnboarding shows the walkthrough, from the start.
func (m *Model) openOnboarding() tea.Cmd {
	ob := newOnboarding(m)
	m.openOverlay(ob)
	return tea.Batch(ob.name.Focus(), ob.bar.SetPercent(ob.fraction()))
}

// relabelKeys draws the key tiles: each key as it is bound here, ticked once pressed.
func (ob *onboarding) relabelKeys(m *Model) {
	ob.keys.tiles = ob.keys.tiles[:0]
	for _, l := range ob.lessons {
		label := keyLabel(l.binding(m.keys).Keys())
		caption, tint := label, m.th.Accent
		if l.tried {
			caption, tint = "✓ "+label, m.th.Success
		}
		ob.keys.tiles = append(ob.keys.tiles, tile{id: label, caption: caption, art: iconArt(l.symbol, tint, wrapTo(l.does, tileArtCols, 3)...)})
	}
}

// applyTheme styles the huh fields from the theme in use, so they change with the Look step.
func (ob *onboarding) applyTheme(m *Model) {
	th := huhTheme(m.th)
	keys := huh.NewDefaultKeyMap()
	ob.name.WithTheme(th).WithKeyMap(keys)
	ob.count.WithTheme(th).WithKeyMap(keys)
	ob.bar = progress.New(progress.WithColors(m.th.Primary, m.th.Secondary), progress.WithoutPercentage(),
		progress.WithFillCharacters('━', '─'), progress.WithSpringOptions(12, 0.9))
	ob.dots.ActiveDot = lipgloss.NewStyle().Foreground(m.th.Primary).Render("●")
	ob.dots.InactiveDot = m.th.Faint.Render("○")
}

// huhTheme is a huh theme in Friday's colours.
func huhTheme(t theme.Theme) huh.Theme {
	return huh.ThemeFunc(func(bool) *huh.Styles {
		s := huh.ThemeBase(!t.Light)
		f := &s.Focused
		f.Base = f.Base.BorderForeground(t.BorderFocus)
		f.Card = f.Base
		f.Title = t.Title
		f.Description = t.Faint
		f.ErrorIndicator = f.ErrorIndicator.Foreground(t.Error)
		f.ErrorMessage = f.ErrorMessage.Foreground(t.Error)
		f.TextInput.Prompt = t.Key
		f.TextInput.Text = t.Body
		f.TextInput.Cursor = lipgloss.NewStyle().Foreground(t.Primary)
		f.TextInput.Placeholder = t.Faint
		f.FocusedButton = f.FocusedButton.Foreground(t.Bg).Background(t.Primary).Bold(true)
		f.BlurredButton = f.BlurredButton.Foreground(t.Muted).Background(t.Surface)
		s.Blurred = s.Focused
		s.Blurred.Base = s.Focused.Base.BorderStyle(lipgloss.HiddenBorder())
		s.Group.Title, s.Group.Description = f.Title, f.Description
		return s
	})
}

func (ob *onboarding) fraction() float64 { return float64(ob.step+1) / float64(obSteps) }

// grid is the step's tiles, if it has any.
func (ob *onboarding) grid() *tileGrid {
	switch ob.step {
	case obLook:
		return &ob.themes
	case obMode:
		return &ob.modes
	case obKeys:
		return &ob.keys
	case obStart:
		return &ob.starts
	}
	return nil
}

// goTo moves to step s, focusing its field and moving the bar.
func (ob *onboarding) goTo(m *Model, s onboardStep) tea.Cmd {
	ob.name.Blur()
	ob.count.Blur()
	ob.step = s
	ob.dots.Page = int(s)
	cmds := []tea.Cmd{ob.bar.SetPercent(ob.fraction())}
	switch s {
	case obHello:
		cmds = append(cmds, ob.name.Focus())
	case obConnect:
		cmds = append(cmds, ob.count.Focus())
	}
	return tea.Batch(cmds...)
}

func (ob *onboarding) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	k := msg.String()
	switch k {
	case "ctrl+c", "esc":
		return true, ob.finish(m, "")
	case "enter":
		if ob.step == obStart {
			return true, ob.finish(m, ob.starts.tiles[ob.starts.cursor].id)
		}
		return false, ob.goTo(m, ob.step+1)
	case "backspace":
		if ob.step != obHello && ob.step > 0 {
			return false, ob.goTo(m, ob.step-1)
		}
	}
	switch ob.step {
	case obHello:
		_, cmd := ob.name.Update(msg)
		return false, cmd
	case obConnect:
		_, cmd := ob.count.Update(msg)
		return false, cmd
	case obKeys:
		// A key tried lights its tile; the arrows still move between them.
		for i, l := range ob.lessons {
			if key.Matches(msg, l.binding(m.keys)) {
				ob.lessons[i].tried, ob.keys.cursor = true, i
				ob.relabelKeys(m)
				return false, nil
			}
		}
	}
	if g := ob.grid(); g != nil && g.move(k, 1) && ob.step == obLook {
		m.applyTheme(ob.themes.tiles[ob.themes.cursor].id)
		ob.applyTheme(m)
	}
	return false, nil
}

// rowCount and choose make the step's tiles clickable: a click picks the tile, as moving to it does.
func (ob *onboarding) rowCount() int {
	if g := ob.grid(); g != nil {
		return len(g.tiles)
	}
	return 0
}

func (ob *onboarding) choose(m *Model, i int) tea.Cmd {
	g := ob.grid()
	if g == nil || i >= len(g.tiles) {
		return nil
	}
	g.cursor = i
	if ob.step == obLook {
		m.applyTheme(g.tiles[i].id)
		ob.applyTheme(m)
	}
	return nil
}

// onboardSavedMsg is a setting the walkthrough saved; only a failure is worth saying.
type onboardSavedMsg struct {
	key string
	err error
}

// finish remembers the walkthrough and applies what was chosen: the theme and the install count
// saved as settings, the mode set once the session is open, a first request in the input. A
// missing provider opens the connect dialog next.
func (ob *onboarding) finish(m *Model, request string) tea.Cmd {
	name := strings.TrimSpace(ob.nameValue)
	m.firstRun.name = name
	_ = config.UpdateState(m.opts.ConfigDir, func(s *config.State) { s.Onboarded, s.Name = true, name })
	var cmds []tea.Cmd
	if m.th.Name != ob.themeAtStart {
		cmds = append(cmds, m.saveSettingLater("ARCHYMEDES_THEME", m.th.Name))
	}
	if ob.countOn != ob.counted {
		cmds = append(cmds, m.saveSettingLater("ARCHYMEDES_TELEMETRY", map[bool]string{true: "on", false: "off"}[ob.countOn]))
	}
	if mode := ob.modes.tiles[ob.modes.cursor].id; mode != m.mode {
		if m.session.ID != "" {
			cmds = append(cmds, m.setMode(mode))
		} else {
			m.firstRun.mode = mode
		}
	}
	if request != "" {
		m.input.take()
		m.input.area.InsertString(request)
	}
	if ob.setup != nil {
		m.overlay = nil
		cmds = append(cmds, m.openFirstRun(*ob.setup))
		return tea.Batch(cmds...)
	}
	greeting := "You're set"
	if name != "" {
		greeting += ", " + name
	}
	return tea.Batch(append(cmds, m.toast(toastInfo, greeting+" · /welcome shows this again"))...)
}

// saveSettingLater saves a setting through the agent, or once it has started.
func (m *Model) saveSettingLater(key, value string) tea.Cmd {
	if m.agent == nil {
		if m.firstRun.settings == nil {
			m.firstRun.settings = map[string]string{}
		}
		m.firstRun.settings[key] = value
		return nil
	}
	agent := m.agent
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		result, err := agent.SetSetting(ctx, key, value)
		if err == nil && !result.OK {
			err = errors.New(result.Error)
		}
		return onboardSavedMsg{key, err}
	}
}

// savedLater flushes the settings chosen before the agent started.
func (m *Model) savedLater() tea.Cmd {
	var cmds []tea.Cmd
	for _, k := range slices.Sorted(maps.Keys(m.firstRun.settings)) {
		cmds = append(cmds, m.saveSettingLater(k, m.firstRun.settings[k]))
	}
	m.firstRun.settings = nil
	return tea.Batch(cmds...)
}

// agentStarted opens the session, or the connect dialog when no provider is ready; while the
// walkthrough is up, a missing provider waits for its end.
func (m *Model) agentStarted(msg startedMsg) tea.Cmd {
	m.agent = msg.agent
	m.forward(m.agent)
	later := m.savedLater()
	if ob, ok := m.overlay.(*onboarding); ok && !msg.status.Configured {
		ob.setup = &msg.status
		return later
	}
	if msg.status.Configured {
		return tea.Batch(later, m.openSession())
	}
	return tea.Batch(later, m.openFirstRun(msg.status))
}

// modeChosenEarlier sets the mode the walkthrough chose before the session opened.
func (m *Model) modeChosenEarlier() tea.Cmd {
	mode := m.firstRun.mode
	m.firstRun.mode = ""
	if mode == "" || mode == m.mode {
		return nil
	}
	return m.setMode(mode)
}

// onboardFocus focuses the walkthrough's first field when it opened with the model.
func (m *Model) onboardFocus() tea.Cmd {
	if ob, ok := m.overlay.(*onboarding); ok {
		return ob.goTo(m, ob.step)
	}
	return nil
}

func (m *Model) onboardSaved(msg onboardSavedMsg) tea.Cmd {
	if msg.err != nil {
		return m.toast(toastWarn, "Could not save "+msg.key+": "+msg.err.Error())
	}
	return nil
}

// barFrame moves the animated bars: the limit bar's, and the walkthrough's while it is open.
func (m *Model) barFrame(msg progress.FrameMsg) tea.Cmd {
	var cmd, more tea.Cmd
	m.limitBar, cmd = m.limitBar.Update(msg)
	if ob, ok := m.overlay.(*onboarding); ok {
		ob.bar, more = ob.bar.Update(msg)
	}
	return tea.Batch(cmd, more)
}

// --- view ---

func (ob *onboarding) view(m *Model) string {
	th := m.th
	width := gridWidth(m, 4)
	inner := max(width-4, 1)
	ob.bar.SetWidth(inner)
	bar := ob.bar.ViewAs(ob.fraction()) // a bar rebuilt for a new theme has no frames coming
	if ob.bar.IsAnimating() {
		bar = ob.bar.View()
	}
	head := bar + "\n" + ob.dots.View() + "  " + th.Faint.Render(onboardTitles[ob.step]) +
		th.Faint.Render(" · step "+strconv.Itoa(int(ob.step)+1)+" of "+strconv.Itoa(int(obSteps)))
	var body string
	switch ob.step {
	case obHello:
		body = ob.helloView(m, inner)
	case obLook:
		body = ob.stepView(th, "Pick a look", "Each tile is the whole screen in that theme; moving previews it.", ob.themes.view(m, inner, tileArtRows+3))
	case obMode:
		body = ob.stepView(th, "How much may Friday do alone?", "A mode is a promise about changes. "+keyLabel(m.keys.Mode.Keys())+" cycles them any time.", ob.modes.view(m, inner, tileArtRows+3))
	case obKeys:
		tried := 0
		for _, l := range ob.lessons {
			if l.tried {
				tried++
			}
		}
		note := "Press each key to try it here; nothing opens yet."
		if tried == len(ob.lessons) {
			note = th.OK.Render("All four. ") + th.Faint.Render("enter sends a request; tab offers one to start from.")
		}
		body = ob.stepView(th, "Four keys to know", note, ob.keys.view(m, inner, tileArtRows+3))
	case obConnect:
		body = ob.connectView(m, inner)
	case obStart:
		body = ob.stepView(th, "Where to start", "Pick a first request; it goes in the input for you to send or change.", ob.starts.view(m, inner, tileArtRows+3))
	}
	help := m.help
	help.SetWidth(inner)
	foot := help.ShortHelpView(ob.bindings())
	title := "Welcome to Friday"
	if ob.nameValue != "" && ob.step != obHello {
		title = "Welcome, " + strings.TrimSpace(ob.nameValue)
	}
	return frame(th, title, head+"\n\n"+body+"\n\n"+foot, width)
}

// stepView is a step's question, a line under it, and its tiles.
func (ob *onboarding) stepView(th theme.Theme, question, note, tiles string) string {
	return th.Strong.Render(question) + "\n" + th.Faint.Render(note) + "\n\n" + tiles
}

// helloView is the mark beside what Friday is, and the name field.
func (ob *onboarding) helloView(m *Model, width int) string {
	th := m.th
	about := []string{
		theme.Gradient("F R I D A Y", th.Primary, th.Secondary, true),
		th.Faint.Render("a coding agent that shows its work"),
		"",
		th.Body.Render("It reads your project, plans, edits and"),
		th.Body.Render("runs commands. Every change is shown,"),
		th.Body.Render("can be undone, and waits on your mode."),
		"",
		th.Faint.Render("Six short steps. esc skips them."),
	}
	text := strings.Join(about, "\n")
	if solid := render.Geometry(m.angle, false); width >= 23+4+40 {
		ramp := lipgloss.Blend1D(len(solid)*2, th.Primary, th.Secondary, th.Primary)
		for i, row := range solid {
			solid[i] = lipgloss.NewStyle().Foreground(ramp[i%len(ramp)]).Render(row)
		}
		text = lipgloss.JoinHorizontal(lipgloss.Center, strings.Join(solid, "\n"), "    ", text)
	}
	ob.name.WithWidth(min(width, 60))
	return text + "\n\n" + ob.name.View()
}

// connectView is what the agent is connected to, and the install count question.
func (ob *onboarding) connectView(m *Model, width int) string {
	th := m.th
	var status string
	info := m.session.Info
	switch {
	case ob.setup != nil:
		status = th.Warn.Render("○ No provider is set up yet.") + "\n" +
			th.Faint.Render(ansi.Wordwrap("Next you pick one: free models need only an OpenRouter key; a Claude or ChatGPT plan signs in.", width, " "))
	case m.session.ID != "" && info.Model != "":
		status = th.OK.Render("✓ Ready: ") + th.SoftPill(info.Model, th.Secondary) + th.Faint.Render(" on ") + th.Body.Render(cmp.Or(info.ProviderLabel, info.Provider))
	case m.phase == failed:
		status = th.Bad.Render("✗ The agent did not start; the screen behind says why.")
	default:
		status = th.Highlight.Render(m.spin.View() + " starting the agent…")
	}
	ob.count.WithWidth(min(width, 64))
	return th.Strong.Render("Connection") + "\n" + status + "\n" + th.Faint.Render("Providers (alt+p) and /key change it later.") + "\n\n" + ob.count.View()
}

// bindings are the keys the help line shows for this step.
func (ob *onboarding) bindings() []key.Binding {
	b := func(keys, desc string) key.Binding {
		return key.NewBinding(key.WithKeys(keys), key.WithHelp(keys, desc))
	}
	next := b("enter", "next")
	if ob.step == obStart {
		next = b("enter", "start")
	}
	out := []key.Binding{next}
	if ob.step != obHello {
		out = append(out, b("backspace", "back"))
	}
	switch ob.step {
	case obLook, obMode, obKeys, obStart:
		out = append(out, b("←↑↓→", "move"))
	case obConnect:
		out = append(out, b("←→", "choose"))
	}
	return append(out, b("esc", "skip the rest"))
}
