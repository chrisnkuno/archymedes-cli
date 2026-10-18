package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func submitCommand(m *Model, text string) {
	typeText(m, text)
	run(m, press(m, tea.KeyEnter, 0))
}

func TestSessionCommandsBecomeTranscriptBlocks(t *testing.T) {
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	submitCommand(m, "/cost")
	submitCommand(m, "/diff")
	submitCommand(m, "/todos")
	s := screen(m)
	for _, want := range []string{"cost", "Session cost: USD 0.02", "since the last checkpoint", "-old line", "+new line", "plan 1/3 done", "✓ read the code", "◐ fix it", "○ test it"} {
		if !strings.Contains(s, want) {
			t.Fatalf("screen lacks %q:\n%s", want, s)
		}
	}
	submitCommand(m, "/undo code")
	if !strings.Contains(screen(m), `Reverted "fix the bug".`) || agent.commands[len(agent.commands)-1] != "undo:code" {
		t.Fatalf("undo: %v\n%s", agent.commands, screen(m))
	}
}

func TestResumePickerSwapsTheSessionAndClosesTheOldOne(t *testing.T) {
	m, agent := newTestModel(t)
	m.notice(noticeInfo, "the current conversation")
	submitCommand(m, "/resume")
	p, ok := m.overlay.(*resumePicker)
	if !ok {
		t.Fatal("/resume opens the picker")
	}
	run(m, m.loadSessions())
	if !p.loaded || !strings.Contains(screen(m), "fix the flaky login test") || !strings.Contains(screen(m), "●") {
		t.Fatalf("picker:\n%s", screen(m))
	}
	typeText(m, "flaky")
	run(m, press(m, tea.KeyEnter, 0))
	if m.overlay != nil || agent.resumed != "s0" || strings.Contains(screen(m), "the current conversation") {
		t.Fatalf("overlay=%v resumed=%q\n%s", m.overlay, agent.resumed, screen(m))
	}
	if len(agent.closed) != 1 || agent.closed[0] != "s1" {
		t.Fatalf("closed %v", agent.closed)
	}
}

func TestNewBlocksAndPickerFitEverySize(t *testing.T) {
	m, _ := newTestModel(t)
	submitCommand(m, "/cost")
	submitCommand(m, "/diff")
	submitCommand(m, "/todos")
	for _, size := range [][2]int{{100, 30}, {40, 12}, {14, 4}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		assertFits(t, m, "blocks")
		m.openOverlay(newResumePicker(m))
		assertFits(t, m, "resume picker")
		m.overlay = nil
	}
}

func TestAgentProgramsNeedTheAgentsCommandLine(t *testing.T) {
	m, _ := newTestModel(t)
	// This test model has no agent command line: the command says so instead of failing silently.
	submitCommand(m, "/update")
	if !strings.Contains(screen(m), "needs the agent's command line") {
		t.Fatal(screen(m))
	}
}

func TestCommandsFromTheOldInterfaceSayWhereTheyWent(t *testing.T) {
	m, _ := newTestModel(t)
	submitCommand(m, "/jobs")
	submitCommand(m, "/layout")
	submitCommand(m, "/nonsense")
	s := screen(m)
	for _, want := range []string{"/jobs is not in this version of the interface yet", "/layout is gone", "No command /nonsense"} {
		if !strings.Contains(s, want) {
			t.Fatalf("lacks %q:\n%s", want, s)
		}
	}
}

func TestToolCardsLinkTheirFileAndDrawListingsAsTrees(t *testing.T) {
	m, _ := newTestModel(t)
	m.opts.Cwd = "/home/p"
	read := &toolItem{name: "read_file", args: map[string]any{"path": "src/app.go"}, done: true, result: "a\nb"}
	listing := &toolItem{name: "list_files", args: map[string]any{}, done: true, result: "src/\nsrc/app.go\nsrc/util/str.go\nREADME.md", open: true}
	m.tr.add(read)
	m.tr.add(listing)
	raw := m.View().Content
	if !strings.Contains(raw, "\x1b]8;;file:///home/p/src/app.go") {
		t.Fatal("the file a call read is not a link")
	}
	if s := screen(m); !strings.Contains(s, "util/") || !strings.Contains(s, "└──") {
		t.Fatalf("listing not drawn as a tree:\n%s", s)
	}
	// Still a link when the frame goes through the compositor (a toast is up).
	m.toast(toastInfo, "hello")
	if !strings.Contains(m.View().Content, "\x1b]8;;file:///home/p/src/app.go") {
		t.Fatal("the compositor dropped the link")
	}
}

func TestASessionOpenInAnotherTerminalIsMarkedAndResumedAsACopy(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	submitCommand(m, "/resume")
	p := m.overlay.(*resumePicker)
	p.load(sessionsLoadedMsg{sessions: []acp.SessionSummary{{ID: "s1", Title: "this one"}, {ID: "s9", Title: "refactor the router", OpenElsewhere: true}}})
	typeText(m, "router")
	s := screen(m)
	if !strings.Contains(s, "refactor the router · open in another terminal") || !strings.Contains(s, "enter opens a copy") {
		t.Fatalf("picker:\n%s", s)
	}
	// The agent opened a copy and says why, once, in the conversation.
	m.overlay = nil
	m.Update(connectedMsg{session: acp.Session{ID: "s10", Info: acp.SessionInfo{Model: "m1", Mode: "build", Notice: `"refactor the router" is open in another terminal (pid 42), so this is a copy of it: s10. Approvals start fresh here.`}}})
	if s := screen(m); !strings.Contains(s, "open in another terminal (pid 42)") || m.session.ID != "s10" {
		t.Fatalf("session %q:\n%s", m.session.ID, s)
	}
}
