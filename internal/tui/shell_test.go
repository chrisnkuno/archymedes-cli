package tui

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/config"
)

func fkey(n int) tea.KeyPressMsg { return tea.KeyPressMsg{Code: tea.KeyF1 + rune(n-1)} }

func TestTheDesktopNeedsNoSetup(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 30})
	rows := strings.Split(screen(m), "\n")
	if !strings.Contains(rows[0], "◇") || !strings.Contains(rows[0], "Chat") {
		t.Fatalf("top bar: %q", rows[0])
	}
	dock := rows[len(rows)-1]
	for _, want := range []string{"Chat F1", "Files F2", "Search F3", "Sessions F4", "Models F5", "Themes F6", "Keys F7", "Help F8", "Stats F9", "Changes F10", "Gallery F12"} {
		if !strings.Contains(dock, want) {
			t.Fatalf("dock lacks %q: %q", want, dock)
		}
	}
}

func TestWindowsOpenSwitchCloseAndKeepTheirState(t *testing.T) {
	m := projectModel(t)
	run(m, func() tea.Cmd { _, c := m.Update(fkey(2)); return c }())
	f, ok := m.activeWindow().(*filesView)
	if !ok || !strings.Contains(strings.Split(screen(m), "\n")[0], "Files") {
		t.Fatalf("F2 opens Files: %T", m.activeWindow())
	}
	press(m, tea.KeyDown, 0)
	before, _ := f.selected()
	m.Update(fkey(1))
	if m.activeWindow() != nil || !strings.Contains(screen(m), "Ask Archymedes") {
		t.Fatal("F1 returns to Chat")
	}
	press(m, tea.KeyPgDown, tea.ModCtrl)
	if m.activeWindow() != f {
		t.Fatal("ctrl+pgdown moves to the next window")
	}
	if after, _ := f.selected(); after != before {
		t.Fatal("a window lost its place when switched away from")
	}
	run(m, func() tea.Cmd { _, c := m.Update(fkey(2)); return c }())
	if len(m.windows) != 1 {
		t.Fatalf("opening Files again focuses it, not a second copy: %d windows", len(m.windows))
	}
	press(m, 'w', tea.ModCtrl)
	if len(m.windows) != 0 || m.activeWindow() != nil {
		t.Fatal("ctrl+w closes the window")
	}
	typeText(m, "two words")
	press(m, 'w', tea.ModCtrl)
	if m.input.value() != "two " {
		t.Fatalf("in Chat ctrl+w deletes a word: %q", m.input.value())
	}
}

func TestTheBarsAnswerClicks(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 30})
	x, y := cellOf(t, m, "Files F2")
	run(m, click(m, x+1, y))
	if _, ok := m.activeWindow().(*filesView); !ok {
		t.Fatal("a click on the dock opens the app")
	}
	x, _ = cellOf(t, m, "Chat ")
	click(m, x+1, 0)
	if m.activeWindow() != nil {
		t.Fatal("a click on the Chat tab focuses Chat")
	}
	run(m, click(m, 1, 0))
	if _, ok := m.overlay.(*startMenu); !ok {
		t.Fatal("a click on ◇ opens the start menu")
	}
}

func TestStartMenuFindsAppsActionsSessionsAndFiles(t *testing.T) {
	m := projectModel(t)
	run(m, func() tea.Cmd { _, c := m.Update(tea.KeyPressMsg{Code: tea.KeySpace, Mod: tea.ModCtrl}); return c }())
	s, ok := m.overlay.(*startMenu)
	if !ok {
		t.Fatal("ctrl+space opens the start menu")
	}
	find := func(query, want string) {
		t.Helper()
		s.filter.SetValue(query)
		s.refilter()
		for _, e := range s.shown {
			if strings.Contains(e.label, want) {
				return
			}
		}
		t.Fatalf("%q did not find %q: %v", query, want, s.shown)
	}
	find("files", "▤ Files")
	find("cost", "/cost")
	find("flaky", "fix the flaky login test")
	find("app.go", "src/app.go")
	s.filter.SetValue("app.go")
	s.refilter()
	press(m, tea.KeyEnter, 0)
	if p, ok := m.activeWindow().(*pager); !ok || p.label != "src/app.go" {
		t.Fatalf("enter on a file opens it: %T", m.activeWindow())
	}
}

func TestKeysAppRebindsRefusesAndResetsAndTheChangeSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	agent := &fakeAgent{messages: make(chan any, 16)}
	newModel := func() *Model {
		m := New(Options{NoWallpaper: true, Start: func(context.Context) (Agent, error) { return agent, nil }, ConfigDir: dir})
		m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
		m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
		m.Update(connectedMsg{session: acp.Session{ID: "s1"}})
		return m
	}
	m := newModel()
	m.Update(fkey(7))
	k, ok := m.activeWindow().(*keysApp)
	if !ok {
		t.Fatal("F7 opens Keys")
	}
	for k.selected().id != "files" {
		press(m, tea.KeyDown, 0)
	}
	press(m, tea.KeyEnter, 0)
	if !strings.Contains(screen(m), "press a key") {
		t.Fatalf("waiting for a key:\n%s", screen(m))
	}
	press(m, 'e', tea.ModCtrl)
	if got := m.keys.Files.Keys(); len(got) != 1 || got[0] != "ctrl+e" {
		t.Fatalf("files is %v", got)
	}
	if !strings.Contains(screen(m), "ctrl+e Files") && !strings.Contains(screen(m), "Files ctrl+e") {
		t.Fatalf("dock does not show the new key:\n%s", screen(m))
	}
	data, _ := os.ReadFile(filepath.Join(dir, config.KeysFile))
	if !strings.Contains(string(data), `"ctrl+e"`) {
		t.Fatalf("not saved: %s", data)
	}

	// A key another action uses is refused; so is a key that types text.
	for k.selected().id != "search" {
		press(m, tea.KeyDown, 0)
	}
	press(m, tea.KeyEnter, 0)
	press(m, 'e', tea.ModCtrl)
	if !strings.Contains(screen(m), "already means “files”") || m.keys.Search.Keys()[0] == "ctrl+e" {
		t.Fatalf("conflict not refused:\n%s", screen(m))
	}
	press(m, tea.KeyEnter, 0)
	typeText(m, "f")
	if !strings.Contains(screen(m), "types text") {
		t.Fatalf("plain letter not refused:\n%s", screen(m))
	}

	// Survives a restart.
	if got := newModel().keys.Files.Keys(); got[0] != "ctrl+e" {
		t.Fatalf("after restart files is %v", got)
	}

	// Reset all, and locked keys stay locked.
	typeText(m, "R")
	if got := m.keys.Files.Keys(); got[0] != "f2" {
		t.Fatalf("reset: %v", got)
	}
	for k.selected().id != "send" {
		press(m, tea.KeyDown, 0)
	}
	press(m, tea.KeyEnter, 0)
	if k.waiting || !strings.Contains(screen(m), "fixed") {
		t.Fatal("a locked key offered to be changed")
	}
}

func TestChatTabShowsWorkWhileYouAreElsewhere(t *testing.T) {
	m := projectModel(t)
	typeText(m, "go")
	press(m, tea.KeyEnter, 0)
	run(m, func() tea.Cmd { _, c := m.Update(fkey(2)); return c }())
	if top := strings.Split(screen(m), "\n")[0]; !strings.Contains(top, "Chat ●") {
		t.Fatalf("top bar: %q", top)
	}
}

func TestTheDesktopFitsEverySize(t *testing.T) {
	m := projectModel(t)
	run(m, func() tea.Cmd { _, c := m.Update(fkey(2)); return c }())
	m.openFile("src/app.go")
	m.openWindow(newKeysApp(m))
	for _, size := range [][2]int{{160, 40}, {120, 32}, {80, 24}, {50, 16}, {30, 8}, {14, 4}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		for i := 0; i <= len(m.windows); i++ {
			m.focus(i)
			assertFits(t, m, "window")
			m.openOverlay(newStartMenu(m))
			assertFits(t, m, "start menu over a window")
			m.overlay = nil
		}
	}
}
