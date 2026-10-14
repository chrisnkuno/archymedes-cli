package tui

import (
	"github.com/charmbracelet/x/ansi"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

func TestTheTaskManagerListsTheTurnQueueAndTools(t *testing.T) {
	m, _ := unconfigured(t)
	m.overlay = nil
	m.phase, m.turnStart = busy, time.Now().Add(-5*time.Second)
	m.tr.items = append(m.tr.items, &userItem{text: "build the thing"},
		&toolItem{name: "run_command", args: map[string]any{"command": "npm test"}, done: true, isError: true, started: time.Now().Add(-2 * time.Second), ended: time.Now()},
		&toolItem{name: "write_file", args: map[string]any{"path": "a.js"}, started: time.Now()})
	m.queue = []string{"then deploy it"}
	m.runAction("tasks")
	s := screen(m)
	for _, want := range []string{"turn", "running", "build the thing", "queued", "then deploy it", "run_command npm test", "failed", "write_file a.js"} {
		if !strings.Contains(s, want) {
			t.Errorf("task manager lacks %q:\n%s", want, s)
		}
	}
}

func TestNotificationsKeepWhatToastsSaidAndCountUnread(t *testing.T) {
	m, _ := unconfigured(t)
	m.overlay = nil
	m.toast(toastInfo, "Key saved")
	m.toast(toastWarn, "Rate limited")
	if m.unread != 2 || len(m.notes) != 2 {
		t.Fatalf("unread %d notes %d", m.unread, len(m.notes))
	}
	if !strings.Contains(screen(m), "● 2") {
		t.Fatal("the tray should show the unread count")
	}
	m.runAction("notifications")
	s := screen(m)
	if !strings.Contains(s, "Rate limited") || !strings.Contains(s, "Key saved") || m.unread != 0 {
		t.Fatalf("unread %d:\n%s", m.unread, s)
	}
	press(m, 'c', 0)
	if len(m.notes) != 0 {
		t.Fatal("c clears the history")
	}
}

func TestStoppingFromTheTaskManager(t *testing.T) {
	m, _ := unconfigured(t)
	m.overlay = nil
	m.phase = ready
	m.runAction("tasks")
	press(m, 'x', 0)
	if got := m.notes[len(m.notes)-1].text; got != "Nothing is running" {
		t.Fatalf("note %q", got)
	}
	_ = tea.KeyPressMsg{}
}

func TestTheDockCarriesTheSystemAppsWhereThereIsRoomAndTheyAreClickable(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	dock := m.dock()
	for _, want := range []string{"alt+t", "alt+n", "alt+s"} {
		if !strings.Contains(ansi.Strip(dock), want) {
			t.Errorf("dock lacks %s: %q", want, ansi.Strip(dock))
		}
	}
	for _, app := range systemApps {
		if _, ok := findAction(app.id); !ok {
			t.Errorf("%s has no action", app.id)
		}
	}
}
