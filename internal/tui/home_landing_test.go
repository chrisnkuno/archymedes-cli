package tui

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// Home is always a key away, like a desktop under the windows: alt+h shows the home screen over a
// conversation, even while a turn runs; the turn goes on behind it, its approvals still come up,
// and F1, a send, or the Chat tab bring the conversation back with everything that arrived.

func busyConversation(t *testing.T) (*Model, *fakeAgent) {
	t.Helper()
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 34})
	typeText(m, "port the parser")
	press(m, tea.KeyEnter, 0) // the turn starts; its end is never delivered, so it keeps running
	if m.phase != busy {
		t.Fatal("enter did not start a turn")
	}
	return m, agent
}

func TestHomeOpensOverARunningTurnAndTheTurnGoesOn(t *testing.T) {
	m, _ := busyConversation(t)
	press(m, 'h', tea.ModAlt)
	if !m.landingVisible() {
		t.Fatal("alt+h did not show the home screen over the conversation")
	}
	s := screen(m)
	if !strings.Contains(s, "F R I D A Y") {
		t.Fatalf("the home card is not shown:\n%s", s)
	}
	if !strings.Contains(s, "working") || !strings.Contains(s, "F1") {
		t.Fatalf("home does not say the conversation is working, or how to get back:\n%s", s)
	}
	if !strings.Contains(s, "Chat ●") {
		t.Fatalf("the Chat tab does not show the turn working elsewhere:\n%s", s)
	}
	if m.phase != busy {
		t.Fatal("going home stopped the turn")
	}

	// The turn's words arrive while home is shown, and are there on the way back.
	m.Update(agentMsg{acp.TextChunk{Text: "Parser ported."}})
	if strings.Contains(screen(m), "Parser ported.") {
		t.Fatal("the transcript showed through the home screen")
	}
	press(m, tea.KeyF1, 0)
	if m.landingVisible() {
		t.Fatal("F1 did not bring the conversation back")
	}
	if s := screen(m); !strings.Contains(s, "Parser ported.") || !strings.Contains(s, "port the parser") {
		t.Fatalf("the conversation lost what arrived while home was shown:\n%s", s)
	}
}

func TestAnApprovalComesUpOverHome(t *testing.T) {
	m, _ := busyConversation(t)
	press(m, 'h', tea.ModAlt)
	if !m.landingVisible() {
		t.Fatal("alt+h did not show home")
	}
	var answers []string
	m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{Title: "run command: go test ./..."}, []acp.PermissionOption{
		{OptionID: "allow", Name: "Allow"}, {OptionID: "deny", Name: "Deny"},
	}, func(id string) { answers = append(answers, id) })})
	if s := screen(m); !strings.Contains(s, "go test ./...") {
		t.Fatalf("the approval is not shown over home:\n%s", s)
	}
	typeText(m, "y")
	if len(answers) != 1 || answers[0] != "allow" {
		t.Fatalf("answers = %v", answers)
	}
}

func TestSendingFromHomeGoesBackToTheConversation(t *testing.T) {
	m, _ := busyConversation(t)
	press(m, 'h', tea.ModAlt)
	typeText(m, "also the lexer")
	press(m, tea.KeyEnter, 0)
	if m.landingVisible() {
		t.Fatal("a message sent from home left the conversation hidden")
	}
	if len(m.queue) != 1 || m.queue[0].text != "also the lexer" {
		t.Fatalf("queue = %+v", m.queue) // sent during the turn: it waits in the queue as ever
	}
}

func TestTheChatTabAndTheOtherAppsLeaveHome(t *testing.T) {
	m, _ := busyConversation(t)
	press(m, 'h', tea.ModAlt)
	if !m.landingVisible() {
		t.Fatal("alt+h did not show home")
	}
	press(m, tea.KeyF2, 0) // Files, over home
	if m.activeWindow() == nil {
		t.Fatal("F2 did not open Files from home")
	}
	m.focus(0) // the Chat tab, clicked or chosen on the bar
	if m.landingVisible() {
		t.Fatal("choosing the Chat tab showed home, not the conversation")
	}
}

func TestHomeIsBesideStartAndAClickAway(t *testing.T) {
	m, _ := busyConversation(t)
	top := strings.Split(screen(m), "\n")[0]
	if !strings.Contains(top, "◇") || !strings.Contains(top, "⌂") {
		t.Fatalf("the top bar lacks Home beside Start:\n%s", top)
	}
	time.Sleep(40 * time.Millisecond) // the zone worker scans asynchronously
	box := m.zones.frame.Get("home")
	if box.IsZero() {
		t.Fatal("Home is not a click zone")
	}
	_, cmd := m.Update(tea.MouseClickMsg{X: box.StartX + 1, Y: box.StartY, Button: tea.MouseLeft})
	deliver(m, cmd)
	if !m.landingVisible() {
		t.Fatal("a click on Home did not show the home screen")
	}
	if _, ok := findAction("home"); !ok {
		t.Fatal("home is not a key action, so the Keys app cannot rebind it")
	}
}

func TestHomeWithoutAConversationIsTheHomeScreenAsBefore(t *testing.T) {
	m, _ := newTestModel(t)
	if !m.landingVisible() {
		t.Fatal("a new session does not open on home")
	}
	press(m, 'h', tea.ModAlt)
	press(m, tea.KeyF1, 0)
	if !m.landingVisible() {
		t.Fatal("with no conversation, Chat is still the home screen")
	}
	if strings.Contains(screen(m), "working") {
		t.Fatal("an idle home screen says something is working")
	}
}

// A mode chosen while Friday is still starting is applied once it has started, before the first
// message goes, instead of being dropped without a word.
func TestAModeChosenWhileStartingIsAppliedBeforeTheFirstMessage(t *testing.T) {
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{Cwd: "/tmp/project", NoWallpaper: true})
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	if m.phase != connecting {
		t.Fatalf("phase = %v, want connecting", m.phase)
	}
	cmd := m.setMode("auto")
	if cmd == nil {
		t.Fatal("a mode chosen while starting was dropped without a word")
	}
	deliver(m, cmd)
	m.enqueue("first message")
	_, cmd = m.Update(connectedMsg{session: acp.Session{ID: "s1", Info: acp.SessionInfo{Model: "m1", Mode: "build"}}})
	deliver(m, cmd)
	agent.mu.Lock()
	defer agent.mu.Unlock()
	if len(agent.modes) != 1 || agent.modes[0] != "auto" {
		t.Fatalf("modes = %v, want [auto]", agent.modes)
	}
	if m.mode != "auto" {
		t.Fatalf("mode = %q", m.mode)
	}
	if len(agent.prompts) != 1 {
		t.Fatalf("prompts = %v", agent.prompts)
	}
}
