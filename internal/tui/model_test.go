package tui

import (
	"context"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

type fakeAgent struct {
	// connect: what ConnectProvider answers (OK with providerModels when unset), and what it was given.
	connectResult  *acp.ConnectResult
	connected      []string
	providerModels []string
	remembered     []string
	setupProviders []acp.SetupProvider
	providers      []acp.ProviderOverview
	settings       acp.SettingsList
	set            []string
	setError       string
	mu             sync.Mutex
	prompts        []string
	cancelled      int
	modes          []string
	messages       chan any
	// setup: what SaveSetup answers, and what it was given.
	saveResult acp.SetupResult
	saved      []string
	resumed    string
	models     []string
	commands   []string
	closed     []string
}

func (f *fakeAgent) NewSession(_ context.Context, _ string, resumeID string) (acp.Session, error) {
	f.resumed = resumeID
	return acp.Session{ID: "s1", Info: acp.SessionInfo{Model: "m1", Mode: "build"}}, nil
}
func (f *fakeAgent) Models(context.Context, bool) (acp.ModelList, error) {
	return acp.ModelList{Choices: []acp.ModelChoice{
		{Provider: "anthropic", ProviderLabel: "Anthropic", Model: "claude-sonnet-5", IsDefault: true, Price: "USD 3.00/USD 15.00 per Mtok"},
		{Provider: "anthropic", ProviderLabel: "Anthropic", Model: "claude-opus-5", Price: "USD 15.00/USD 75.00 per Mtok"},
		{Provider: "openai", ProviderLabel: "OpenAI", Model: "gpt-5.6-terra", Price: "unpriced"},
		{Provider: "free", ProviderLabel: "Free models", Model: "meta-llama/llama-4-maverick:free", Price: "free", Free: true},
		{Provider: "google", ProviderLabel: "Google Gemini", Model: "gemini-2.5-pro", Price: "unpriced", Locked: true, Missing: []string{"GOOGLE_API_KEY"}},
	}}, nil
}
func (f *fakeAgent) SetModel(_ context.Context, _ string, provider, model string) (acp.SessionInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.models = append(f.models, provider+"/"+model)
	return acp.SessionInfo{Provider: provider, Model: model, Mode: "build"}, nil
}
func (f *fakeAgent) Command(_ context.Context, _ string, command, argument string) (acp.CommandResult, error) {
	f.mu.Lock()
	f.commands = append(f.commands, command+":"+argument)
	f.mu.Unlock()
	switch command {
	case "diff":
		return acp.CommandResult{Kind: "diff", Patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old line\n+new line\n"}, nil
	case "todos":
		return acp.CommandResult{Kind: "todos", Items: []struct {
			Text   string `json:"text"`
			Status string `json:"status"`
		}{{"read the code", "done"}, {"fix it", "in_progress"}, {"test it", "pending"}}}, nil
	case "undo":
		return acp.CommandResult{Kind: "text", Text: `Reverted "fix the bug".`}, nil
	}
	return acp.CommandResult{Kind: "text", Text: "Session cost: USD 0.02 over 1 request\n  input   1,200 tokens"}, nil
}
func (f *fakeAgent) Sessions(context.Context, string) ([]acp.SessionSummary, error) {
	return []acp.SessionSummary{{ID: "s1", Title: "this one"}, {ID: "s0", Title: "fix the flaky login test"}}, nil
}
func (f *fakeAgent) CloseSession(_ context.Context, id string) error {
	f.mu.Lock()
	f.closed = append(f.closed, id)
	f.mu.Unlock()
	return nil
}
func (f *fakeAgent) Startup(context.Context) ([]string, error) {
	return []string{"Archymedes 3.0.1 is available — /update installs it."}, nil
}
func (f *fakeAgent) SetupStatus(context.Context) (acp.SetupStatus, error) {
	return acp.SetupStatus{Configured: true, Providers: f.setupProviders}, nil
}
func (f *fakeAgent) SaveSetup(_ context.Context, provider, key string) (acp.SetupResult, error) {
	f.saved = append(f.saved, provider+"="+key)
	return f.saveResult, nil
}

func (f *fakeAgent) ConnectProvider(_ context.Context, provider string, values map[string]string) (acp.ConnectResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	keys := make([]string, 0, len(values))
	for k, v := range values {
		keys = append(keys, k+"="+v)
	}
	sort.Strings(keys)
	f.connected = append(f.connected, provider+":"+strings.Join(keys, ","))
	if f.connectResult != nil {
		return *f.connectResult, nil
	}
	return acp.ConnectResult{OK: true, File: "/cfg/settings.json", Models: f.providerModels}, nil
}
func (f *fakeAgent) ProviderModels(context.Context, string) ([]string, string, error) {
	return f.providerModels, "", nil
}
func (f *fakeAgent) RememberModel(_ context.Context, provider, model string) error {
	f.mu.Lock()
	f.remembered = append(f.remembered, provider+"/"+model)
	f.mu.Unlock()
	return nil
}
func (f *fakeAgent) Providers(context.Context) ([]acp.ProviderOverview, error) {
	return f.providers, nil
}
func (f *fakeAgent) Settings(context.Context) (acp.SettingsList, error) {
	return f.settings, nil
}
func (f *fakeAgent) SetSetting(_ context.Context, key, value string) (acp.SettingsSetResult, error) {
	f.mu.Lock()
	f.set = append(f.set, key+"="+value)
	f.mu.Unlock()
	if f.setError != "" {
		return acp.SettingsSetResult{Error: f.setError}, nil
	}
	return acp.SettingsSetResult{OK: true, File: "/cfg/settings.json", Value: value, IsSet: value != ""}, nil
}

func (f *fakeAgent) Prompt(_ context.Context, _ string, text string) (string, error) {
	f.mu.Lock()
	f.prompts = append(f.prompts, text)
	f.mu.Unlock()
	f.messages <- acp.TurnEnded{StopReason: "end_turn"} // in-stream, as the real client sends it
	return "end_turn", nil
}
func (f *fakeAgent) Cancel(string) error { f.mu.Lock(); f.cancelled++; f.mu.Unlock(); return nil }
func (f *fakeAgent) SetMode(_ context.Context, _ string, mode string) error {
	f.modes = append(f.modes, mode)
	return nil
}
func (f *fakeAgent) Messages() <-chan any { return f.messages }
func (f *fakeAgent) Close()               {}

// newTestModel is a connected model at 80x24 with the session already open.
func newTestModel(t *testing.T) (*Model, *fakeAgent) {
	t.Helper()
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{Start: func(context.Context) (Agent, error) { return agent, nil }, Cwd: "/tmp/project"})
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	m.Update(connectedMsg{session: acp.Session{ID: "s1", Info: acp.SessionInfo{Model: "m1", ProviderLabel: "Free", Mode: "build"}}})
	return m, agent
}

func typeText(m *Model, text string) {
	for _, r := range text {
		m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
}

func press(m *Model, code rune, mod tea.KeyMod) tea.Cmd {
	_, cmd := m.Update(tea.KeyPressMsg{Code: code, Mod: mod})
	return cmd
}

// run executes a command and feeds its message back, following the commands that produces (a
// finished turn sending the next queued message). A command that does not return promptly is a
// timer or an agent listener and is dropped, as a test has no clock or agent stream to wait on.
func run(m *Model, cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	result := make(chan tea.Msg, 1)
	go func() { result <- cmd() }()
	var msg tea.Msg
	select {
	case msg = <-result:
	case <-time.After(200 * time.Millisecond):
		return
	}
	switch msg := msg.(type) {
	case nil:
	case tea.BatchMsg:
		for _, c := range msg {
			run(m, c)
		}
	default:
		_, next := m.Update(msg)
		// Animation ticks re-arm themselves forever; following them would never return.
		switch msg.(type) {
		case spinner.TickMsg, animTickMsg:
		default:
			run(m, next)
		}
	}
	drain(m)
}

// drain delivers what the fake agent has queued, as the program's forwarder would.
func drain(m *Model) {
	f, ok := m.agent.(*fakeAgent)
	if !ok {
		return
	}
	for {
		select {
		case msg := <-f.messages:
			_, next := m.Update(agentMsg{msg})
			run(m, next)
		default:
			return
		}
	}
}

func screen(m *Model) string { return ansi.Strip(m.View().Content) }

func TestATurnStreamsTextAndToolsIntoTheTranscript(t *testing.T) {
	m, agent := newTestModel(t)
	typeText(m, "fix the bug")
	cmd := press(m, tea.KeyEnter, 0)
	if m.phase != busy {
		t.Fatal("enter did not start a turn")
	}
	m.Update(agentMsg{acp.TextChunk{Text: "Looking **now**."}})
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "read_file", Arguments: map[string]any{"path": "src/app.ts"}}}}})
	if s := screen(m); !strings.Contains(s, "read file  src/app.ts · running") {
		t.Fatalf("tool call not shown:\n%s", s)
	}
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "tool_result", ToolCallID: "c1", ToolName: "read_file", Content: "a\nb\nc"}}}})
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "model_turn", Usage: &acp.Usage{InputTokens: 1200, OutputTokens: 30}}}}})
	m.Update(agentMsg{acp.TextChunk{Text: "Fixed it."}})
	run(m, cmd)

	s := screen(m)
	for _, want := range []string{"┃ fix the bug", "Looking now.", "✓  read file  src/app.ts · 3 lines", "Fixed it.", " done · ", "↑1.2k", "m1"} {
		if !strings.Contains(s, want) {
			t.Errorf("screen lacks %q:\n%s", want, s)
		}
	}
	if m.phase != ready || len(agent.prompts) != 1 || agent.prompts[0] != "fix the bug" {
		t.Fatalf("phase=%v prompts=%q", m.phase, agent.prompts)
	}
	// Text after a tool call is a new block below it, not appended to the reply above.
	if strings.Index(s, "Looking now.") > strings.Index(s, "read file") || strings.Index(s, "Fixed it.") < strings.Index(s, "read file") {
		t.Fatalf("blocks out of order:\n%s", s)
	}
}

func TestApprovalHoldsTheKeyboardAndEscapeDenies(t *testing.T) {
	m, _ := newTestModel(t)
	var answers []string
	request := func() acp.PermissionRequest {
		return acp.NewPermissionRequestForTest(acp.ToolCallRef{Title: "run command: rm -rf build"}, []acp.PermissionOption{
			{OptionID: "allow", Name: "Allow"}, {OptionID: "allow_always", Name: "Allow this action from now on"}, {OptionID: "deny", Name: "Deny"},
		}, func(id string) { answers = append(answers, id) })
	}
	m.Update(agentMsg{request()})
	// Drawn over the transcript, with the rest of the screen still there around it.
	if s := screen(m); !strings.Contains(s, "rm -rf build") || !strings.Contains(s, "Ask Archymedes") || !strings.Contains(s, "◇") || !strings.Contains(s, "F1") {
		t.Fatalf("dialog not composed over the screen:\n%s", s)
	}
	typeText(m, "x") // not a decision key: ignored, and not typed into the input either
	if m.input.value() != "" || len(answers) != 0 {
		t.Fatal("a stray key leaked past the approval")
	}
	press(m, tea.KeyEscape, 0)
	m.Update(agentMsg{request()})
	typeText(m, "y")
	m.Update(agentMsg{request()})
	press(m, tea.KeyDown, 0)
	press(m, tea.KeyEnter, 0)
	if strings.Join(answers, ",") != "deny,allow,allow_always" {
		t.Fatalf("answers = %q", answers)
	}
}

func TestMessagesSentDuringATurnAreQueuedAndEscapeDropsThem(t *testing.T) {
	m, agent := newTestModel(t)
	typeText(m, "first")
	first := press(m, tea.KeyEnter, 0)
	typeText(m, "second")
	press(m, tea.KeyEnter, 0)
	if len(m.queue) != 1 {
		t.Fatalf("queue = %q", m.queue)
	}
	run(m, first) // first turn ends; the queued message is sent next
	if len(agent.prompts) != 2 || agent.prompts[1] != "second" {
		t.Fatalf("prompts = %q", agent.prompts)
	}

	typeText(m, "third")
	press(m, tea.KeyEnter, 0)
	press(m, tea.KeyEscape, 0)
	if agent.cancelled != 1 || len(m.queue) != 0 {
		t.Fatalf("cancelled=%d queue=%q", agent.cancelled, m.queue)
	}
}

func TestCtrlCStopsClearsThenQuits(t *testing.T) {
	m, _ := newTestModel(t)
	typeText(m, "draft")
	if cmd := press(m, 'c', tea.ModCtrl); cmd != nil || m.input.value() != "" {
		t.Fatal("first ctrl+c clears the input")
	}
	if cmd := press(m, 'c', tea.ModCtrl); cmd != nil || !m.quitArmed {
		t.Fatal("ctrl+c on an empty input arms quitting")
	}
	if cmd := press(m, 'c', tea.ModCtrl); cmd == nil {
		t.Fatal("second ctrl+c quits")
	}
}

func TestSlashCommandsCompleteAndRun(t *testing.T) {
	m, agent := newTestModel(t)
	typeText(m, "/th")
	if len(m.input.complete) != 1 || !strings.Contains(screen(m), "/theme") {
		t.Fatalf("completions = %v", m.input.complete)
	}
	press(m, tea.KeyTab, 0)
	if m.input.value() != "/theme " {
		t.Fatalf("value = %q", m.input.value())
	}
	typeText(m, "parchment")
	press(m, tea.KeyEnter, 0)
	if m.th.Name != "parchment" {
		t.Fatalf("theme = %s", m.th.Name)
	}
	typeText(m, "/plan")
	run(m, press(m, tea.KeyEnter, 0))
	if m.mode != "plan" || len(agent.modes) != 1 {
		t.Fatalf("mode = %s %v", m.mode, agent.modes)
	}
	typeText(m, "/nonsense")
	press(m, tea.KeyEnter, 0)
	if !strings.Contains(screen(m), "No command /nonsense") {
		t.Fatal(screen(m))
	}
	typeText(m, "//literal")
	run(m, press(m, tea.KeyEnter, 0))
	if agent.prompts[len(agent.prompts)-1] != "/literal" {
		t.Fatalf("prompts = %q", agent.prompts)
	}
}

// The invariant the TS front end kept breaking: every frame is exactly the terminal's height, and
// no row is wider than the terminal, whatever is on screen and however small the window gets.
func TestEveryFrameFitsTheTerminal(t *testing.T) {
	m, _ := newTestModel(t)
	typeText(m, "go")
	press(m, tea.KeyEnter, 0)
	m.Update(agentMsg{acp.TextChunk{Text: "# Heading\n\n" + strings.Repeat("wide 漢字 text ", 40) + "\n\n```\n" + strings.Repeat("x", 300) + "\n```"}})
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c", ToolName: "run_command", Arguments: map[string]any{"command": strings.Repeat("y", 400)}}}}})
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "tool_result", ToolCallID: "c", ToolName: "run_command", IsError: true, Content: "exit 1\n\t" + strings.Repeat("z", 500)}}}})
	typeText(m, "/")
	for _, size := range [][2]int{{80, 24}, {120, 40}, {40, 12}, {20, 6}, {12, 3}, {200, 60}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		for _, withDialog := range []bool{false, true} {
			if withDialog {
				m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{Title: strings.Repeat("long title ", 30)}, []acp.PermissionOption{{OptionID: "allow", Name: "Allow"}}, func(string) {})})
			}
			rows := strings.Split(m.View().Content, "\n")
			if len(rows) != size[1] {
				t.Fatalf("%dx%d dialog=%v: %d rows", size[0], size[1], withDialog, len(rows))
			}
			for i, row := range rows {
				if w := ansi.StringWidth(row); w > size[0] {
					t.Fatalf("%dx%d dialog=%v: row %d is %d wide: %q", size[0], size[1], withDialog, i, w, ansi.Strip(row))
				}
			}
			m.approval = nil
		}
	}
}

func TestScrolledBackViewStaysPutWhileOutputArrives(t *testing.T) {
	m, _ := newTestModel(t)
	for i := 0; i < 40; i++ {
		m.notice(noticeInfo, "line "+strings.Repeat("·", i%5)+string(rune('A'+i%26)))
	}
	press(m, tea.KeyPgUp, 0)
	before := screen(m)
	m.Update(agentMsg{acp.TextChunk{Text: "new output\nmore\nmore"}})
	transcriptRows := func(s string) string { return strings.Join(strings.Split(s, "\n")[1:m.transcriptHeight()], "\n") }
	if transcriptRows(screen(m)) != transcriptRows(before) {
		t.Fatalf("view moved while scrolled back:\n%s\n----\n%s", before, screen(m))
	}
	press(m, tea.KeyEscape, 0)
	if !m.tr.following() || !strings.Contains(screen(m), "new output") {
		t.Fatal("esc returns to live output")
	}
}

func TestEachModelCallIsItsOwnBlockAndStopNoticesDoNotRepeatTheReply(t *testing.T) {
	m, _ := newTestModel(t)
	typeText(m, "go")
	press(m, tea.KeyEnter, 0)
	m.Update(agentMsg{acp.TextChunk{Text: "Verified."}})
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "model_turn"}}}})
	m.Update(agentMsg{acp.TextChunk{Text: "The command printed it."}})
	m.Update(agentMsg{acp.AgentEvent{Event: acp.Event{Type: "runtime", Event: &acp.RuntimeEvent{Type: "runtime_stop", Status: "needs_verification",
		Summary: "Workspace changes were made without passing verification evidence. The agent reported: The command printed it."}}}})
	s := screen(m)
	if strings.Contains(s, "Verified.The") || strings.Count(s, "The command printed it.") != 1 {
		t.Fatalf("blocks merged or reply repeated:\n%s", s)
	}
	if !strings.Contains(s, "without passing verification evidence.") {
		t.Fatalf("verdict missing:\n%s", s)
	}
}

// The end of a turn comes in the agent's stream after the turn's last words, so the closing rule
// is always drawn below them.
func TestTheTurnEndsAfterItsLastWords(t *testing.T) {
	m, agent := newTestModel(t)
	agent.messages <- acp.TextChunk{Text: "first words"}
	typeText(m, "go")
	cmd := press(m, tea.KeyEnter, 0)
	agent.messages <- acp.TextChunk{Text: " and the last words"}
	run(m, cmd)
	s := screen(m)
	if strings.Index(s, "the last words") < 0 || strings.Index(s, " done · ") < strings.Index(s, "the last words") {
		t.Fatalf("turn ended above its last words:\n%s", s)
	}
}
