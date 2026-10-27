package tui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestEachTerminalGetsOneKindOfNotification(t *testing.T) {
	env := func(pairs ...string) func(string) string {
		m := map[string]string{}
		for i := 0; i+1 < len(pairs); i += 2 {
			m[pairs[i]] = pairs[i+1]
		}
		return func(k string) string { return m[k] }
	}
	cases := []struct {
		name string
		env  func(string) string
		want string
	}{
		{"iTerm2", env("TERM_PROGRAM", "iTerm.app"), "\x1b]9;Friday finished\a"},
		{"WezTerm", env("TERM_PROGRAM", "WezTerm"), "\x1b]9;Friday finished\a"},
		{"kitty", env("TERM", "xterm-kitty"), "\x1b]99;;Friday finished\x1b\\"},
		{"foot", env("TERM", "foot"), "\x1b]777;notify;Friday;Friday finished\a"},
		{"tmux, even in iTerm2", env("TMUX", "/tmp/tmux", "TERM_PROGRAM", "iTerm.app"), "\a"},
		{"anything else", env("TERM", "xterm-256color"), "\a"},
	}
	for _, c := range cases {
		if got := notificationSequence(c.env, "Friday finished"); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
	if got := notificationSequence(env("TERM", "foot"), "a;b"); got != "\x1b]777;notify;Friday;a,b\a" {
		t.Errorf("a semicolon would split OSC 777: %q", got)
	}
}

func TestANotificationCannotCarryAControlSequence(t *testing.T) {
	got := notificationText("run \x1b]52;c;evil\a rm\n -rf " + strings.Repeat("x", 200))
	if strings.ContainsAny(got, "\x1b\a\n") || len([]rune(got)) > 120 {
		t.Fatalf("%q", got)
	}
}

// pushServer records what a push URL received.
type pushServer struct {
	mu     sync.Mutex
	bodies []string
	titles []string
}

func (p *pushServer) serve(t *testing.T) string {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		p.mu.Lock()
		p.bodies, p.titles = append(p.bodies, string(body)), append(p.titles, r.Header.Get("Title"))
		p.mu.Unlock()
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// runAll executes a command and every command a batch holds.
func runAll(cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	if batch, ok := cmd().(tea.BatchMsg); ok {
		for _, c := range batch {
			runAll(c)
		}
	}
}

func TestFridaySaysWhenItNeedsYouOnlyWhileYouLookAway(t *testing.T) {
	var push pushServer
	t.Setenv("ARCHYMEDES_NOTIFY_URL", push.serve(t))
	t.Setenv("ARCHYMEDES_NOTIFY", "")
	m, _ := newTestModel(t)
	approval := acp.PermissionRequest{ToolCall: acp.ToolCallRef{Title: "run rm -rf build"}}

	m.Update(agentMsg{msg: approval})
	if len(m.notifier.pending) != 0 {
		t.Fatal("notified while the terminal had focus")
	}
	m.nextApproval()

	m.Update(tea.BlurMsg{})
	_, cmd := m.Update(agentMsg{msg: approval})
	runAll(cmd)
	m.nextApproval()
	_, cmd = m.Update(promptDoneMsg{stop: "end_turn"})
	runAll(cmd)
	_, cmd = m.Update(promptDoneMsg{stop: "cancelled"})
	runAll(cmd)

	push.mu.Lock()
	defer push.mu.Unlock()
	want := []string{"Friday needs your approval in project", "Friday finished in project"}
	if strings.Join(push.bodies, "|") != strings.Join(want, "|") {
		t.Fatalf("pushed %q, want %q (a stop the person made is not news)", push.bodies, want)
	}
	for _, b := range push.bodies {
		if strings.Contains(b, "rm -rf") {
			t.Fatalf("the push named the command: %q", b)
		}
	}
	if push.titles[0] != "Friday" {
		t.Errorf("title %q", push.titles[0])
	}

	m.Update(tea.FocusMsg{})
	m.Update(agentMsg{msg: acp.QuestionRequest{Question: "Which?"}})
	if len(m.notifier.pending) != 0 {
		t.Fatal("notified after focus came back")
	}
}

func TestAlwaysAndOff(t *testing.T) {
	t.Setenv("ARCHYMEDES_NOTIFY_URL", "")
	t.Setenv("ARCHYMEDES_NOTIFY", "always")
	m, _ := newTestModel(t)
	m.notifyTurnEnded(promptDoneMsg{stop: "end_turn"})
	if len(m.notifier.pending) != 1 {
		t.Fatalf("always, while focused: %d pending", len(m.notifier.pending))
	}
	m.notifier.pending = nil
	t.Setenv("ARCHYMEDES_NOTIFY", "off")
	m.notifier.blurred = true
	m.notifyTurnEnded(promptDoneMsg{stop: "end_turn"})
	if len(m.notifier.pending) != 0 {
		t.Fatal("off still notified")
	}
}

func TestTheContextGaugeMeasuresWhatCompactionMeasures(t *testing.T) {
	known := acp.SessionInfo{ContextLimit: 100_000, CompactAt: 0.8, ContextKnown: true}
	for _, c := range []struct {
		used int
		info acp.SessionInfo
		text string
		near bool
	}{
		{0, known, "", false},
		{46_000, known, "ctx 46%", false},
		{72_000, known, "ctx 72%", true},
		{46_000, acp.SessionInfo{ContextLimit: 100_000, CompactAt: 0.8}, "ctx ~46%", false},
		{46_000, acp.SessionInfo{}, "", false},
	} {
		text, near := contextGauge(c.used, c.info)
		if text != c.text || near != c.near {
			t.Errorf("%d of %+v: %q %v, want %q %v", c.used, c.info, text, near, c.text, c.near)
		}
	}
}

func TestAnMCPToolReadsAsItsToolAndServer(t *testing.T) {
	for name, want := range map[string]string{"mcp__github__create_issue": "create issue · github MCP", "read_file": "read file", "mcp__odd": "mcp  odd"} {
		if got := toolLabel(name); got != want {
			t.Errorf("toolLabel(%q) = %q, want %q", name, got, want)
		}
	}
}
