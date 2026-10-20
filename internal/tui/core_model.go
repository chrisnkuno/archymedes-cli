// Package tui is the terminal front end: one Bubble Tea model, with components as plain structs it
// calls directly (the pattern Charm's Crush uses), drawing into fixed regions of the alt screen.
package tui

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/log/v2"
	"github.com/NimbleMarkets/ntcharts/v2/picture"
	"github.com/NimbleMarkets/ntcharts/v2/picture/pictureurl"
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/i18n"
	"github.com/chrisnkuno/friday-cli/internal/render"
	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// Agent is the running agent as the model needs it; *acp.Client implements it.
type Agent interface {
	NewSession(ctx context.Context, cwd, resumeID string) (acp.Session, error)
	SetupStatus(ctx context.Context) (acp.SetupStatus, error)
	SaveSetup(ctx context.Context, provider, key string) (acp.SetupResult, error)
	Settings(ctx context.Context) (acp.SettingsList, error)
	Providers(ctx context.Context) ([]acp.ProviderOverview, error)
	ConnectProvider(ctx context.Context, provider string, values map[string]string) (acp.ConnectResult, error)
	ProviderModels(ctx context.Context, provider string) ([]string, string, error)
	RememberModel(ctx context.Context, provider, model string) error
	SetSetting(ctx context.Context, key, value string) (acp.SettingsSetResult, error)
	Models(ctx context.Context, refresh bool) (acp.ModelList, error)
	SetModel(ctx context.Context, sessionID, provider, model string) (acp.SessionInfo, error)
	Command(ctx context.Context, sessionID, command, argument string) (acp.CommandResult, error)
	Sessions(ctx context.Context, cwd string) ([]acp.SessionSummary, error)
	CloseSession(ctx context.Context, sessionID string) error
	Startup(ctx context.Context) ([]string, error)
	Prompt(ctx context.Context, sessionID, text string) (string, error)
	Cancel(sessionID string) error
	SetMode(ctx context.Context, sessionID, mode string) error
	Steer(ctx context.Context, sessionID, text string) (bool, error)
	Messages() <-chan any
	Close()
}

// Start launches the agent process; it runs off the UI goroutine.
type Start func(ctx context.Context) (Agent, error)

// Options configure a Model.
type Options struct {
	Theme string
	Start Start
	// Resume is a stored session id, or "latest"; empty opens a new session.
	Resume string
	// Prompt, when set, is sent as soon as the session is ready.
	Prompt string
	// Mouse enables wheel scrolling. Off keeps the terminal's own text selection.
	Mouse bool
	Cwd   string
	// Version is shown on the landing screen and in the help overlay.
	Version string
	// Debug, when set, receives a structured log of what the interface handles (ARCHYMEDES_DEBUG_LOG).
	Debug *log.Logger
	// Motion animates scrolling on a spring; off, every move is immediate (reduced motion, tests).
	Motion bool
	// ConfigDir is where changed key bindings are kept (keys.json); empty keeps them in memory only.
	ConfigDir string
	// AgentArgv runs the agent directly (without `acp`), for commands that are the agent's own
	// programs: /settings, /update, /providers.
	AgentArgv []string
	// NoPhotos leaves the photographs out (ARCHYMEDES_PHOTOS=off): text only, everywhere.
	NoPhotos bool
	// NoWallpaper keeps the photographs but not behind the screen (ARCHYMEDES_WALLPAPER=off).
	NoWallpaper bool
	// PhotosOffline keeps the photographs to the copies built in (ARCHYMEDES_PHOTOS=local): the
	// Gallery does not fetch the full-resolution ones from Unsplash.
	PhotosOffline bool
}

type phase int

const (
	connecting phase = iota
	ready
	busy
	failed
)

type usageTotals struct{ input, output int }

// Model is the whole UI.
type Model struct {
	opts   Options
	th     theme.Theme
	md     *render.Markdown
	width  int
	height int

	tr       *transcript
	input    composer
	approval *approval
	// approvals wait behind the one on screen: parallel tool calls ask at once, and each is answered.
	approvals []*approval
	// pendingMode is a mode chosen during a turn: the agent changes mode between turns, so it is
	// applied the moment this one ends, before anything queued is sent.
	pendingMode string
	overlay     overlay // a dialog over the focused window
	// windows are the open apps beside Chat; active is the focused one (0 = Chat, i = windows[i-1]).
	windows  []window
	active   int
	expanded bool

	keys     keyMap
	help     help.Model
	spin     spinner.Model
	spinning bool // a spinner tick chain is running
	animated bool // the landing animation's tick chain is running
	angle    float64
	homeT    float64 // the tour drawer's scene clock, seconds; still under reduced motion
	// tourOpen is whether the home screen's tour drawer is wanted out; tourSlide how far out it is
	// (0 folded, 1 open), eased toward that on each tick (home_drawer.go).
	tourOpen  bool
	tourSlide float64
	// The home screen's photograph (desk_photos.go): which one, since when, and the drawings by size.
	photoIndex int
	photoAt    time.Time
	photoCache map[string][]string
	quitting   bool           // quit was asked for: nothing more is drawn
	wall       *wallpaperGrid // the wallpaper for wallKey: photo, size, dimming and theme
	wallKey    string
	// wallChoice is the wallpaper the person picked (config.State.Wallpaper): "" takes turns, a
	// photo id keeps that one, "off" shows the theme's ground.
	wallChoice string
	// The last frame laid over the wallpaper, and the result, reused while neither changes.
	underIn, underOut string
	underGrid         *wallpaperGrid
	// The terminal's cell size in pixels once it has said (CSI 16 t), so photos keep their shape,
	// and its window size in pixels (CSI 14 t), for terminals that only say that.
	cellW, cellH   int
	pixelW, pixelH int
	// Sixel (desk_sixel.go): whether the terminal draws it, and what the pictures on screen were drawn
	// for — all of it, and where they sit.
	sixel                bool
	sixelSig, sixelPlace string
	// First-run guidance (home_welcome.go): whether the first request was ever sent, whether this
	// session sent it (its first turn ends with a tip), and how many files the project has changed.
	welcomed       bool
	firstTurnTip   bool
	projectChanged int
	toasts         []toast
	toastSeq       int
	// knownFiles is the project's file list once read (by /files, or for @ completion).
	knownFiles []string
	scroll     scroller
	stats      sessionStats
	zones      zones // click targets, one manager per layer (core_zones.go)
	// keyOverrides are the bindings someone changed (keys.json), saved in configDir.
	keyOverrides map[string][]string
	// startupNote is said once the interface is up (a toast), e.g. a keys file that could not be read.
	startupNote string
	// shiftEnter: the terminal tells shift+enter from enter (it answered the keyboard enhancement
	// request), so that is the newline key worth showing.
	shiftEnter bool
	// recentSessions is this project's stored sessions, newest first, once read.
	recentSessions []acp.SessionSummary
	filesLoading   bool
	sender         func(tea.Msg)

	agent   Agent
	session acp.Session
	mode    string
	phase   phase

	current   *assistantItem
	tools     map[string]*toolItem
	queue     []string
	comments  []reviewComment // notes on diff lines, sent with the next message
	goal      *goalState      // /goal in progress
	turnStart time.Time
	turnUsage usageTotals
	usage     usageTotals
	retrying  string
	// text is the interface's words in the person's language (ARCHYMEDES_LANGUAGE, else the locale).
	text *i18n.Catalog
	// composing is the tool call the model is writing right now, shown in place of "thinking…".
	composing *acp.RuntimeEvent
	testFirst *acp.TestFirstState // this turn's test-first progress; nil until a test or code is written
	// The running retry's wait, drawn as a countdown bar (Bubbles progress).
	retryStart  time.Time
	retryDelay  time.Duration
	retryBar    progress.Model
	quitArmed   bool
	limited     map[string]time.Time // models that answered 429 lately, for the picker
	sel         selection
	bodyLines   []string // what the transcript last drew, for selection
	limits      limitTracker
	limitBar    progress.Model
	forecast    forecast
	lastLevel   limitLevel
	limitWarned time.Time
	shellCancel context.CancelFunc // the !command running, if any
	effort      [2]string          // the last model call's reasoning effort and the reason for it
	notes       []note             // every toast, for the notification center
	unread      int
	custom      []command
	selecting   bool // the terminal owns the mouse (/select)
}

// New builds the model; Init connects.
func New(opts Options) *Model {
	th, _ := theme.Load(opts.Theme)
	m := &Model{opts: opts, tr: newTranscript(), tools: map[string]*toolItem{}, mode: "build", th: th, md: render.NewMarkdown(th)}
	m.keyOverrides = map[string][]string{}
	if opts.ConfigDir != "" {
		overrides, err := config.LoadKeys(opts.ConfigDir)
		if err != nil {
			m.startupNote = "keys.json could not be read (" + err.Error() + "); using the default keys"
		}
		m.keyOverrides = overrides
	}
	m.keys = newKeyMap(m.keyOverrides)
	m.text = i18n.Load(i18n.Resolve(config.Setting(opts.ConfigDir, "ARCHYMEDES_LANGUAGE"), os.Getenv))
	m.photoIndex = time.Now().YearDay() // a different photo first each day
	// Without a config directory there is nowhere to remember a welcome, so do not give one.
	state := config.LoadState(opts.ConfigDir)
	m.welcomed = opts.ConfigDir == "" || state.Welcomed
	m.wallChoice = state.Wallpaper
	m.tourOpen = !state.TourHidden
	m.input = newComposer(th)
	m.scroll = newScroller()
	m.stats = newSessionStats()
	m.zones = newZones()
	m.retryBar = newRetryBar(th)
	m.reloadCustomCommands()
	m.limitBar = newLimitBar(m)
	m.help = newHelp(th)
	m.spin = spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(th.Highlight))
	if opts.Theme != "" && th.Name != strings.ToLower(strings.TrimSpace(opts.Theme)) {
		m.notice(noticeWarn, fmt.Sprintf("No theme %q; using %s. /theme lists them.", opts.Theme, th.Name))
	}
	return m
}

func (m *Model) applyTheme(name string) {
	m.th, _ = theme.Load(name)
	m.md = render.NewMarkdown(m.th)
	m.input.applyTheme(m.th)
	m.help = newHelp(m.th)
	m.spin.Style = m.th.Highlight
	m.retryBar = newRetryBar(m.th)
	m.limitBar = newLimitBar(m)
	m.tr.cache = map[item]cached{} // colours are baked into cached lines
}

// --- messages ---

// startedMsg: the agent process is up, and this is whether it can open a session as configured.
type startedMsg struct {
	agent  Agent
	status acp.SetupStatus
}
type connectedMsg struct{ session acp.Session }

// startupNoticesMsg is what the agent's start-of-day upkeep had to say (an update installed or available).
type startupNoticesMsg struct{ notices []string }
type connectFailedMsg struct{ err error }
type agentMsg struct{ msg any }
type promptDoneMsg struct {
	stop string
	err  error
}
type modeSetMsg struct {
	mode string
	err  error
}

func (m *Model) Init() tea.Cmd {
	start := m.opts.Start
	return tea.Batch(func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		agent, err := start(ctx)
		if err != nil {
			return connectFailedMsg{err}
		}
		status, err := agent.SetupStatus(ctx)
		if err != nil {
			// An agent without the setup extension: assume it is configured and let session/new say otherwise.
			status = acp.SetupStatus{Configured: true}
		}
		return startedMsg{agent, status}
		// What the terminal can draw: its cell size, whether it draws Sixel (DA1), its window in pixels.
	}, tea.RequestBackgroundColor, picture.RequestCellSize(), tea.Raw(ansi.RequestPrimaryDeviceAttributes+ansi.WindowOp(14)),
		m.animate(), m.sayStartupNote(), limitTick())
}

func (m *Model) sayStartupNote() tea.Cmd {
	if m.startupNote == "" {
		return nil
	}
	return m.toast(toastWarn, m.startupNote)
}

// openSession asks the agent for the session: a new one, or the one being resumed.
func (m *Model) openSession() tea.Cmd {
	agent, cwd, resume := m.agent, m.opts.Cwd, m.opts.Resume
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		session, err := agent.NewSession(ctx, cwd, resume)
		if err != nil {
			return connectFailedMsg{err}
		}
		return connectedMsg{session}
	}
}

// animate starts whichever tick chains the screen now needs and are not already running: the
// spinner while the agent starts or works, the landing mark while it is on screen. Each chain
// stops by itself once its reason is gone, so an idle session does not repaint.
func (m *Model) animate() tea.Cmd {
	var cmds []tea.Cmd
	if (m.phase == connecting || m.phase == busy) && !m.spinning {
		m.spinning = true
		cmds = append(cmds, m.spin.Tick)
	}
	if m.landingVisible() && !m.animated {
		m.animated = true
		cmds = append(cmds, animTick())
	}
	if s, ok := m.activeWindow().(*showcaseApp); ok {
		cmds = append(cmds, s.wake()) // brought back to the front: moving again
	}
	return tea.Batch(cmds...)
}

// SetSender gives the model the program's Send, which delivers the agent's messages: one goroutine
// forwards the agent's stream in order for the whole session, so a turn's end (acp.TurnEnded, sent
// after the turn's last event) can never overtake its last words.
func (m *Model) SetSender(send func(tea.Msg)) { m.sender = send }

func (m *Model) forward(agent Agent) {
	if m.sender == nil {
		return // tests deliver the agent's messages themselves
	}
	send := m.sender
	go func() {
		for msg := range agent.Messages() {
			send(agentMsg{msg})
		}
	}()
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	model, cmd := m.update(msg)
	// Sixel pictures are drawn over the frame, not in it: after any change, draw them again.
	if sixel := m.sixelAfter(); sixel != nil {
		cmd = tea.Batch(cmd, sixel)
	}
	return model, cmd
}

func (m *Model) update(msg tea.Msg) (tea.Model, tea.Cmd) {
	m.debug(msg)
	// The Gallery's pictures own their messages: fetched photos, Kitty frames, the Kitty probe.
	if _, cell := msg.(uv.CellSizeEvent); !cell && pictureurl.IsPictureMsg(msg) {
		if g := m.galleryWindow(); g != nil {
			return m, g.update(m, msg)
		}
		return m, nil
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.sel.clear()
		m.input.setWidth(m.width - 4)
		if g := m.galleryWindow(); g != nil {
			return m, g.relayout(m)
		}
		return m, nil
	case sixelDrawMsg:
		return m, m.sixelDraw(msg)
	case uv.PrimaryDeviceAttributesEvent:
		for _, attr := range msg {
			if attr == 4 { // Sixel graphics
				m.sixel = true
			}
		}
		if g := m.galleryWindow(); g != nil {
			g.sixel = m.sixel
			return m, g.upgrade()
		}
		return m, nil
	case uv.PixelSizeEvent:
		m.pixelW, m.pixelH = msg.Width, msg.Height
		return m, nil
	case uv.CellSizeEvent:
		if msg.Width > 0 && msg.Height > 0 && (msg.Width != m.cellW || msg.Height != m.cellH) {
			m.cellW, m.cellH, m.photoCache = msg.Width, msg.Height, nil
		}
		if g := m.galleryWindow(); g != nil {
			return m, g.update(m, msg)
		}
		return m, nil
	case spinner.TickMsg:
		m.stats.roll(time.Now())
		if m.phase != connecting && m.phase != busy {
			m.spinning = false
			return m, nil
		}
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd
	case showcaseTickMsg:
		return m, m.showcaseTicked()
	case animTickMsg:
		if !m.landingVisible() {
			m.animated = false
			return m, nil
		}
		m.angle += 0.06
		if m.opts.Motion {
			m.homeT += animInterval.Seconds()
			m.stepTourDrawer()
		}
		m.turnPhoto(time.Now())
		return m, animTick()
	case tea.BackgroundColorMsg:
		// On a light terminal, unless a theme was asked for, use the light one: a dark ground's
		// palette on white is unreadable, and the person never chose it.
		if !msg.IsDark() && m.opts.Theme == "" && !m.th.Light {
			m.applyTheme("parchment")
		}
		return m, nil
	case toastExpiredMsg:
		m.expireToast(msg.id)
		return m, nil
	case startedMsg:
		m.agent = msg.agent
		m.forward(m.agent)
		if msg.status.Configured {
			return m, m.openSession()
		}
		return m, m.openFirstRun(msg.status)
	case shellDoneMsg:
		return m, m.shellDone(msg)
	case openedMsg:
		if msg.err != nil {
			return m, m.toast(toastWarn, "The editor failed: "+msg.err.Error())
		}
		return m, nil
	case providersLoadedMsg:
		m.providersLoaded(msg)
		return m, nil
	case defaultProviderMsg:
		return m, m.defaultProviderSaved(msg)
	case settingsLoadedMsg:
		m.settingsLoaded(msg)
		return m, nil
	case settingSavedMsg:
		return m, m.settingSaved(msg)
	case limitTickMsg:
		return m, m.limitTicked()
	case progress.FrameMsg:
		var cmd tea.Cmd
		m.limitBar, cmd = m.limitBar.Update(msg)
		return m, cmd
	case editedMsg:
		return m, m.edited(msg)
	case connectProvidersMsg:
		return m, m.connectProvidersLoaded(msg)
	case connectResultMsg:
		return m, m.connectResult(msg)
	case connectModelsMsg:
		return m, m.connectModels(msg)
	case signedInMsg:
		return m, m.signedIn(msg)
	case firstRunReadyMsg:
		return m, m.firstRunReady(msg)
	case filesLoadedMsg:
		m.filesLoaded(msg)
		return m, nil
	case projectStateMsg:
		m.projectChanged = msg.changed
		return m, nil
	case changesLoadedMsg:
		return m, m.changesLoaded(msg)
	case diffLoadedMsg:
		m.diffLoaded(msg)
		return m, nil
	case branchesLoadedMsg:
		return m, m.branchesLoaded(msg)
	case branchDetailMsg:
		m.branchDetailLoaded(msg)
		return m, nil
	case modelsLoadedMsg:
		return m, m.modelsLoaded(msg)
	case modelSetMsg:
		return m, m.modelSet(msg)
	case commandDoneMsg:
		return m, m.commandDone(msg)
	case steerDoneMsg:
		return m, m.steerDone(msg)
	case pushPlanMsg:
		return m, m.pushPlanned(msg)
	case pushedMsg:
		return m, m.pushed(msg)
	case worktreeMadeMsg:
		return m, m.worktreeMade(msg)
	case worktreeBackMsg:
		return m, m.worktreeBack(msg)
	case turnsLoadedMsg:
		if p, ok := m.overlay.(*rewindPicker); ok {
			return m, p.load(m, msg)
		}
		return m, nil
	case turnDiffMsg:
		if p, ok := m.overlay.(*rewindPicker); ok {
			p.diffLoaded(msg)
		}
		return m, nil
	case handoffDoneMsg:
		return m, m.handoffDone(msg)
	case sessionsLoadedMsg:
		if msg.err == nil {
			m.recentSessions = msg.sessions
		}
		switch p := m.overlay.(type) {
		case *resumePicker:
			p.load(msg)
		case *startMenu:
			p.addSessions(m)
		}
		return m, nil
	case startupNoticesMsg:
		var cmds []tea.Cmd
		for _, notice := range msg.notices {
			cmds = append(cmds, m.toast(toastInfo, notice))
		}
		return m, tea.Batch(cmds...)
	case connectedMsg:
		first := m.session.ID == ""
		m.session, m.phase = msg.session, ready
		m.reloadCustomCommands()
		if msg.session.Info.Mode != "" {
			m.mode = msg.session.Info.Mode
		}
		if msg.session.Info.Notice != "" {
			m.notice(noticeInfo, msg.session.Info.Notice)
		}
		if m.opts.Prompt != "" {
			m.queue = append([]string{m.opts.Prompt}, m.queue...)
		}
		cmds := []tea.Cmd{m.animate()}
		if first {
			cmds = append(cmds, m.readProjectState())
			// Once, in the background, after the session is usable: never on the way to the prompt.
			agent := m.agent
			cmds = append(cmds, func() tea.Msg {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
				defer cancel()
				notices, _ := agent.Startup(ctx)
				return startupNoticesMsg{notices}
			})
		}
		if len(m.queue) > 0 {
			next := m.queue[0]
			m.queue = m.queue[1:]
			cmds = append(cmds, m.send(next))
		}
		return m, tea.Batch(cmds...)
	case connectFailedMsg:
		m.phase = failed
		m.animated = false
		m.notice(noticeError, "Could not start the agent: "+msg.err.Error())
		return m, nil
	case agentMsg:
		if end, ok := msg.msg.(acp.TurnEnded); ok {
			return m, m.finishTurn(promptDoneMsg{stop: end.StopReason})
		}
		m.handleAgent(msg.msg)
		return m, nil
	case promptDoneMsg:
		return m, m.finishTurn(msg)
	case modeSetMsg:
		if msg.err != nil {
			m.notice(noticeError, "Mode change failed: "+msg.err.Error())
			return m, nil
		}
		m.mode = msg.mode
		return m, m.toast(toastInfo, "Mode: "+msg.mode+" — "+modeBlurb[msg.mode])
	case tea.KeyboardEnhancementsMsg:
		m.shiftEnter = msg.Flags != 0
		return m, nil
	case tea.PasteMsg:
		return m, m.routePaste(msg, msg.Content)
	case tea.ClipboardMsg:
		return m, m.routePaste(tea.PasteMsg{Content: msg.Content}, msg.Content)
	case scrollTickMsg:
		return m, m.stepScroll()
	case tea.MouseClickMsg:
		m.selectPress(msg)
		return m, m.handleClick(msg)
	case tea.MouseMotionMsg:
		m.selectDrag(msg)
		return m, nil
	case tea.MouseReleaseMsg:
		return m, m.selectRelease()
	case tea.MouseWheelMsg:
		m.sel.clear() // the text moves under it
		if p, ok := m.activeWindow().(*pager); ok && m.overlay == nil {
			var cmd tea.Cmd
			p.vp, cmd = p.vp.Update(msg)
			return m, cmd
		}
		switch msg.Mouse().Button {
		case tea.MouseWheelUp:
			return m, m.scrollBy(3)
		case tea.MouseWheelDown:
			return m, m.scrollBy(-3)
		}
		return m, nil
	case tea.KeyPressMsg:
		return m, m.handleKey(msg)
	}
	return m, m.input.update(msg)
}

// modeBlurb is what each mode lets the agent do, in a phrase.
var modeBlurb = map[string]string{
	"plan": "read-only, investigates and proposes", "build": "edits with your approval",
	"auto": "edits and runs without asking", "defender": "security triage",
}

func nextMode(mode string) string {
	cycle := []string{"plan", "build", "auto"}
	i := slices.Index(cycle, mode)
	return cycle[(i+1)%len(cycle)]
}

// submit sends what was typed: a command runs now; a message is sent, or queued behind a running turn.
func (m *Model) submit() tea.Cmd {
	text := m.input.take()
	if text == "" {
		return nil
	}
	// "!command" is the person's own shell, run here and shown here, not sent to the agent.
	if strings.HasPrefix(text, "!") {
		return m.runShell(text[1:])
	}
	if cmd, ok := m.runCommand(text); ok {
		return cmd
	}
	if strings.HasPrefix(text, "//") {
		text = text[1:] // "//x" sends "/x" to the model
	}
	switch m.phase {
	case busy:
		return m.steer(text)
	case ready:
		return m.send(text)
	case connecting:
		m.queue = append(m.queue, text)
		return nil
	}
	m.notice(noticeError, "The agent is not running; restart Friday.")
	return nil
}

func (m *Model) send(text string) tea.Cmd {
	text = m.withReviewComments(text)
	m.sel.clear()
	m.tr.add(&userItem{text: text})
	m.stats.startTurn(text, time.Now())
	m.welcome()
	m.stopScroll()
	m.tr.toBottom()
	m.phase, m.turnStart, m.turnUsage, m.current, m.retrying, m.composing, m.testFirst = busy, time.Now(), usageTotals{}, nil, "", nil, nil
	agent, id := m.agent, m.session.ID
	return tea.Batch(func() tea.Msg {
		// A finished turn arrives in the agent's stream (acp.TurnEnded); only a failure comes back here.
		if _, err := agent.Prompt(context.Background(), id, text); err != nil {
			return promptDoneMsg{err: err}
		}
		return nil
	}, m.animate())
}

func (m *Model) finishTurn(msg promptDoneMsg) tea.Cmd {
	m.stats.endTurn(msg.stop, time.Now())
	var reread tea.Cmd
	if c := m.changesWindow(); c != nil {
		reread = c.reload(m) // the turn's edits have landed
	}
	m.closeAssistant()
	for _, t := range m.tools {
		if !t.done {
			t.finish("not finished", true)
		}
	}
	m.tools = map[string]*toolItem{}
	m.dropApprovals()
	m.retrying = ""
	if msg.err != nil {
		m.notice(noticeError, msg.err.Error())
	}
	if msg.err == nil || msg.stop != "" {
		m.tr.add(&turnItem{stopReason: msg.stop, usage: m.turnUsage, seconds: time.Since(m.turnStart).Seconds(), testFirst: m.testFirst})
	}
	if m.phase == failed {
		return reread
	}
	m.phase = ready
	tip := m.afterFirstTurn()
	// A mode chosen during the turn goes first: whatever is sent next runs under it.
	var modeChange tea.Cmd
	if m.pendingMode != "" {
		modeChange = m.setMode(m.pendingMode)
	}
	then := func(cmds ...tea.Cmd) tea.Cmd {
		if modeChange == nil {
			return tea.Batch(cmds...)
		}
		return tea.Sequence(modeChange, tea.Batch(cmds...))
	}
	if m.goal != nil && len(m.queue) == 0 {
		if msg.err != nil {
			m.goal = nil // a failed turn ends the goal: repeating it would fail the same way
		} else {
			return then(reread, tip, m.goalTurnEnded(msg.stop))
		}
	}
	if len(m.queue) > 0 {
		next := m.queue[0]
		m.queue = m.queue[1:]
		return then(reread, tip, m.send(next))
	}
	return then(reread, tip)
}

func (m *Model) cancelTurn() tea.Cmd {
	if m.phase != busy {
		return nil
	}
	m.queue = nil // stopping means stopping, not moving on to the next queued message
	m.goal = nil
	_ = m.agent.Cancel(m.session.ID)
	return m.toast(toastInfo, "Stopping…")
}

func (m *Model) setMode(mode string) tea.Cmd {
	if !slices.Contains(acp.Modes, mode) {
		return m.toast(toastWarn, fmt.Sprintf("No mode %q — choose %s", mode, strings.Join(acp.Modes, ", ")))
	}
	if m.agent == nil {
		return nil
	}
	if m.phase == busy {
		if mode == m.mode {
			m.pendingMode = ""
			return m.toast(toastInfo, "Staying in "+mode+" mode")
		}
		m.pendingMode = mode
		return m.toast(toastInfo, "Switching to "+mode+" mode when this turn ends")
	}
	m.pendingMode = ""
	agent, id := m.agent, m.session.ID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return modeSetMsg{mode, agent.SetMode(ctx, id, mode)}
	}
}

func (m *Model) quit() tea.Cmd {
	if m.agent != nil {
		if m.phase == busy {
			_ = m.agent.Cancel(m.session.ID)
		}
		go m.agent.Close()
	}
	// Not closing the zone managers: Bubble Tea draws once more after this Update, and a scan on a
	// closed manager blocks once its buffer fills (a frame with 200+ click targets would hang the
	// exit). Quitting draws nothing instead, and the process ends with the managers.
	m.quitting = true
	return tea.Quit
}

func (m *Model) notice(kind noticeKind, text string) {
	m.tr.add(&noticeItem{kind: kind, text: text})
}
