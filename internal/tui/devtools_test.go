package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

func readyModel(t *testing.T) (*Model, *fakeAgent) {
	t.Helper()
	m, agent := unconfigured(t)
	m.overlay = nil
	m.phase, m.session.ID = ready, "s1"
	m.session.Info.Provider, m.session.Info.Model = "openai", "gpt-5.6-terra"
	m.opts.Cwd = t.TempDir()
	return m, agent
}

func lastShell(t *testing.T, m *Model) *shellItem {
	t.Helper()
	for i := len(m.tr.items) - 1; i >= 0; i-- {
		if s, ok := m.tr.items[i].(*shellItem); ok {
			return s
		}
	}
	t.Fatal("no shell item")
	return nil
}

func TestABangRunsTheCommandInTheProjectAndShowsItsOutputWithoutTheAgent(t *testing.T) {
	m, agent := readyModel(t)
	if err := os.WriteFile(filepath.Join(m.opts.Cwd, "marker.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	typeText(m, "!ls && echo done")
	run(m, press(m, tea.KeyEnter, 0))
	s := lastShell(t, m)
	if !s.done || s.exitCode != 0 || !strings.Contains(s.output, "marker.txt") || !strings.Contains(s.output, "done") {
		t.Fatalf("%+v", s)
	}
	if len(agent.prompts) != 0 {
		t.Fatalf("a !command must not reach the agent: %v", agent.prompts)
	}
	if out := screen(m); !strings.Contains(out, "$ ls && echo done") || !strings.Contains(out, "marker.txt") {
		t.Fatalf("screen:\n%s", out)
	}
}

func TestAFailingCommandShowsItsExitCode(t *testing.T) {
	m, _ := readyModel(t)
	run(m, m.runShell("echo oops; exit 3"))
	if s := lastShell(t, m); s.exitCode != 3 || !strings.Contains(s.output, "oops") || !strings.Contains(screen(m), "exit 3") {
		t.Fatalf("%+v", s)
	}
}

func TestEscStopsARunningCommand(t *testing.T) {
	m, _ := readyModel(t)
	cmd := m.runShell("sleep 5")
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	time.Sleep(100 * time.Millisecond)
	press(m, tea.KeyEscape, 0)
	select {
	case msg := <-done:
		m.Update(msg)
	case <-time.After(3 * time.Second):
		t.Fatal("esc did not stop the command")
	}
	if s := lastShell(t, m); s.err != "stopped" {
		t.Fatalf("%+v", s)
	}
	if m.shellCancel != nil {
		t.Fatal("a stopped command must free the shell for the next one")
	}
}

func TestOnlyOneCommandAtATimeAndABareBangExplains(t *testing.T) {
	m, _ := readyModel(t)
	m.runShell("sleep 1")
	m.runShell("echo second")
	if !strings.Contains(m.toasts[len(m.toasts)-1].text, "still running") {
		t.Fatalf("%+v", m.toasts)
	}
	m.stopShell()
	m.shellCancel = nil
	m.runShell("   ")
	if !strings.Contains(m.toasts[len(m.toasts)-1].text, "!<command>") {
		t.Fatalf("%+v", m.toasts)
	}
}

func TestTheOutputBufferKeepsTheEnd(t *testing.T) {
	var b limitedBuffer
	b.Write([]byte(strings.Repeat("a", shellMaxOutput)))
	b.Write([]byte("THE END"))
	if b.Len() != shellMaxOutput || !strings.HasSuffix(b.String(), "THE END") {
		t.Fatalf("len %d", b.Len())
	}
}

func TestOpenTellsEachEditorTheLine(t *testing.T) {
	for _, c := range []struct {
		arg, file string
		line      int
	}{{"src/app.ts:42", "src/app.ts", 42}, {"src/app.ts", "src/app.ts", 0}, {"C:/x/a.go:7", "C:/x/a.go", 7}, {"a:b", "a:b", 0}} {
		if f, l := splitLine(c.arg); f != c.file || l != c.line {
			t.Errorf("%q -> %q %d", c.arg, f, l)
		}
	}
	if got := strings.Join(editorArgs("nvim", "a.go", 3), " "); got != "+3 a.go" {
		t.Error(got)
	}
	if got := strings.Join(editorArgs("code", "a.go", 3), " "); got != "--goto a.go:3" {
		t.Error(got)
	}
	if got := strings.Join(editorArgs("code", "a.go", 0), " "); got != "a.go" {
		t.Error(got)
	}
}

func TestOpenNeedsAnEditorAndAnExistingFile(t *testing.T) {
	m, _ := readyModel(t)
	t.Setenv("VISUAL", "")
	t.Setenv("EDITOR", "")
	m.cmdOpen("a.go")
	if !strings.Contains(m.toasts[len(m.toasts)-1].text, "$EDITOR") {
		t.Fatalf("%+v", m.toasts)
	}
	t.Setenv("EDITOR", "true")
	m.cmdOpen("missing.go")
	if !strings.Contains(m.toasts[len(m.toasts)-1].text, "does not exist") {
		t.Fatalf("%+v", m.toasts)
	}
	os.WriteFile(filepath.Join(m.opts.Cwd, "a.go"), []byte("package a"), 0o644)
	if cmd := m.cmdOpen("@a.go:3"); cmd == nil {
		t.Fatal("an existing file opens")
	}
}

func TestNewStartsAFreshSessionAndCommitAsksTheAgent(t *testing.T) {
	m, agent := readyModel(t)
	m.tr.add(&userItem{text: "old"})
	run(m, m.cmdNew(""))
	if len(m.tr.items) != 0 || agent.resumed != "" || len(agent.closed) == 0 || agent.closed[0] != "s1" {
		t.Fatalf("items %d resumed %q closed %v", len(m.tr.items), agent.resumed, agent.closed)
	}
	m.phase = ready
	run(m, m.cmdCommit("one commit please"))
	if got := agent.prompts[len(agent.prompts)-1]; !strings.Contains(got, "git status") || !strings.Contains(got, "Do not push") || !strings.Contains(got, "one commit please") {
		t.Fatalf("prompt %q", got)
	}
}

func TestOneKeyUndoRetryAndCopy(t *testing.T) {
	m, agent := readyModel(t)
	run(m, m.send("build it"))
	m.phase = ready
	run(m, press(m, 'r', tea.ModAlt))
	if n := len(agent.prompts); n != 2 || agent.prompts[1] != "build it" {
		t.Fatalf("alt+r should resend: %v", agent.prompts)
	}
	m.phase = ready
	run(m, press(m, 'z', tea.ModAlt))
	if len(agent.commands) == 0 || !strings.HasPrefix(agent.commands[len(agent.commands)-1], "undo") {
		t.Fatalf("alt+z should undo: %v", agent.commands)
	}
}

func TestTheProvidersAppActsOnTheSelectedProvider(t *testing.T) {
	m, agent := readyModel(t)
	agent.providers = []acp.ProviderOverview{
		{ID: "free", Label: "Free models (OpenRouter)", Configured: false, Missing: []string{"OPENROUTER_API_KEY"}, KeyVariable: "OPENROUTER_API_KEY", KeyURL: "https://openrouter.ai/keys", Model: "openrouter/free"},
		{ID: "openai", Label: "OpenAI", Configured: true, Model: "gpt-5.6-terra", KeyVariable: "OPENAI_API_KEY"},
		{ID: "groq", Label: "Groq", Configured: true, Model: "openai/gpt-oss-120b", KeyVariable: "GROQ_API_KEY"},
		{ID: "openai-compatible", Label: "OpenAI-compatible", Missing: []string{"OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"}, Model: "x"},
	}
	agent.setupProviders = []acp.SetupProvider{{ID: "free", Label: "Free models (OpenRouter)", KeyVariable: "OPENROUTER_API_KEY"}}
	run(m, m.runAction("providers"))
	s := screen(m)
	for _, want := range []string{"Providers", "2 of 4 ready", "in use", "needs OPENROUTER_API_KEY", "Get a key: https://openrouter.ai/keys"} {
		if !strings.Contains(s, want) {
			t.Errorf("lacks %q:\n%s", want, s)
		}
	}
	// enter on a provider with no key asks for its key
	run(m, press(m, tea.KeyEnter, 0))
	if setup, ok := m.overlay.(*setupOverlay); !ok || !setup.entering || setup.chosen().ID != "free" {
		t.Fatalf("expected the key field for free, got %T", m.overlay)
	}
	m.overlay = nil
	// enter on a ready provider switches the session to it
	press(m, tea.KeyDown, 0)
	press(m, tea.KeyDown, 0)
	run(m, press(m, tea.KeyEnter, 0))
	if len(agent.models) == 0 || agent.models[len(agent.models)-1] != "groq/openai/gpt-oss-120b" || m.session.Info.Provider != "groq" {
		t.Fatalf("switched %v, provider %q", agent.models, m.session.Info.Provider)
	}
	// d makes it the default
	run(m, press(m, 'd', 0))
	if len(agent.set) == 0 || agent.set[len(agent.set)-1] != "ARCHYMEDES_PROVIDER=groq" {
		t.Fatalf("set %v", agent.set)
	}
	// a provider that needs more than a key opens Settings on it
	press(m, tea.KeyDown, 0)
	run(m, press(m, tea.KeyEnter, 0))
	if st := m.settingsWindow(); st == nil || st.filter != "OpenAI-compatible" {
		t.Fatalf("settings window %+v", st)
	}
}

func TestTheProvidersAppFitsEverySize(t *testing.T) {
	m, agent := readyModel(t)
	agent.providers = []acp.ProviderOverview{
		{ID: "free", Label: "Free models (OpenRouter)", Missing: []string{"OPENROUTER_API_KEY"}, KeyVariable: "OPENROUTER_API_KEY", KeyURL: "https://openrouter.ai/keys", Model: "openrouter/free"},
		{ID: "openai-compatible", Label: "OpenAI-compatible", Missing: []string{"OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"}, Model: "a-very-long-model-name-that-goes-on-and-on"},
	}
	run(m, m.runAction("providers"))
	for _, size := range [][2]int{{30, 8}, {50, 14}, {80, 24}, {120, 32}, {200, 50}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		assertFits(t, m, "providers")
	}
}
