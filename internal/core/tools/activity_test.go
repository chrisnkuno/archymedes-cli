//go:build !windows

package tools

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// activityOf is the activity with this id or call id, waiting up to a while for it to appear.
func activityOf(t *testing.T, w *Workspace, id string, ok func(Activity) bool) Activity {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, a := range w.jobs.Activity() {
			if (a.ID == id || a.CallID == id) && ok(a) {
				return a
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no activity %s as wanted in %+v", id, w.jobs.Activity())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestABackgroundCommandShowsWhatItIsDoing(t *testing.T) {
	w, tools := bg(t)
	j := start(t, w, tools, "for i in $(seq 1 25); do echo line $i; done; sleep 30")
	a := activityOf(t, w, j.ID, func(a Activity) bool { return len(a.Tail) == ActivityTailLines })
	if a.Command != j.Command || a.Dir != w.Root || a.Pid != j.Pid || !a.Background || a.Status != "running" {
		t.Fatalf("activity: %+v", a)
	}
	if a.Tail[0] != "line 16" || a.Tail[ActivityTailLines-1] != "line 25" {
		t.Fatalf("the last %d lines, oldest first: %q", ActivityTailLines, a.Tail)
	}
	if a.LastOutput.IsZero() || a.Elapsed <= 0 || a.Stuck {
		t.Fatalf("it printed and has run: %+v", a)
	}
}

// fakeClock is a clock a test moves, and a CPU counter that never moves.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeClock) Add(d time.Duration) { c.mu.Lock(); c.now = c.now.Add(d); c.mu.Unlock() }

func TestAHungBackgroundCommandLooksStuckAfterTheThreshold(t *testing.T) {
	w, tools := bg(t)
	clock := &fakeClock{now: time.Now()}
	w.jobs.now = clock.Now
	w.jobs.cpu = func(int) (uint64, bool) { return 42, true }
	j := start(t, w, tools, "echo ready; sleep 60")
	activityOf(t, w, j.ID, func(a Activity) bool { return len(a.Tail) == 1 })
	for elapsed := 30 * time.Second; elapsed < StallAfter; elapsed += 30 * time.Second {
		clock.Add(30 * time.Second)
		if a := activityOf(t, w, j.ID, func(Activity) bool { return true }); a.Stuck {
			t.Fatalf("stuck before %s: %+v", StallAfter, a)
		}
	}
	clock.Add(time.Minute)
	if a := activityOf(t, w, j.ID, func(Activity) bool { return true }); !a.Stuck || a.Quiet < StallAfter {
		t.Fatalf("quiet and idle past %s should look stuck: %+v", StallAfter, a)
	}
	// Stopped, it is no longer stuck: it has ended.
	if _, err := w.jobs.StopActivity(j.ID); err != nil {
		t.Fatal(err)
	}
	if a := activityOf(t, w, j.ID, func(a Activity) bool { return a.Status != "running" }); a.Stuck || a.Status != "stopped" {
		t.Fatalf("a stopped command: %+v", a)
	}
}

func TestRestartRunsTheSameCommandInTheSameFolder(t *testing.T) {
	w, tools := bg(t)
	j := start(t, w, tools, "pwd; sleep 60")
	text, err := w.jobs.RestartActivity(j.ID)
	if err != nil {
		t.Fatal(err)
	}
	waitDone(t, j, 5*time.Second)
	if j.View().Status != JobStopped {
		t.Fatalf("the old one is stopped first: %+v", j.View())
	}
	jobs := w.jobs.List()
	again := jobs[len(jobs)-1]
	if again == j || again.Command != j.Command || again.Dir != j.Dir || !strings.Contains(text, again.ID) {
		t.Fatalf("restarted as %+v, said %q", again, text)
	}
	a := activityOf(t, w, again.ID, func(a Activity) bool { return len(a.Tail) == 1 })
	if a.Tail[0] != w.Root {
		t.Fatalf("it runs in %q, want %q", a.Tail[0], w.Root)
	}
	if _, err := w.jobs.RestartActivity("cmd99"); err == nil {
		t.Fatal("an unknown id is an error")
	}
}

func TestAForegroundCommandIsWatchedWhileItRunsAndCanBeStopped(t *testing.T) {
	w, tools := bg(t)
	done := make(chan tool.Result, 1)
	go func() {
		done <- tools["run_command"].Run(context.Background(), tool.Context{CallID: "call-7"}, tool.Args{"command": "echo compiling; sleep 60"})
	}()
	a := activityOf(t, w, "call-7", func(a Activity) bool { return a.Pid > 0 && len(a.Tail) == 1 })
	if a.Background || a.CallID != "call-7" || a.Command != "echo compiling; sleep 60" || a.Tail[0] != "compiling" || a.Status != "running" {
		t.Fatalf("foreground activity: %+v", a)
	}
	if _, err := w.jobs.StopActivity(a.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-done:
		if !strings.Contains(r.Content, "Stopped by the person") {
			t.Fatalf("the model is told who stopped it: %q", r.Content)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not end the foreground command")
	}
	for _, a := range w.jobs.Activity() {
		if a.CallID == "call-7" {
			t.Fatalf("an ended foreground command leaves the list: %+v", a)
		}
	}
}

func TestAForegroundRestartRunsItAgainInTheSameCall(t *testing.T) {
	w, tools := bg(t)
	marker := w.Root + "/runs"
	done := make(chan tool.Result, 1)
	go func() {
		done <- tools["run_command"].Run(context.Background(), tool.Context{CallID: "c2"}, tool.Args{"command": "echo run >> " + marker + "; if [ $(wc -l < " + marker + ") -lt 2 ]; then sleep 60; fi; echo finished"})
	}()
	a := activityOf(t, w, "c2", func(a Activity) bool { return a.Pid > 0 })
	if _, err := w.jobs.RestartActivity(a.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-done:
		if !strings.Contains(r.Content, "finished") || !strings.Contains(r.Content, "Restarted by the person") || r.IsError {
			t.Fatalf("the second run's result, with the restart said: %+v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restart did not run it again")
	}
}

// A test run the person stops is a cancel, not a timing: it must not teach the project's test-time
// history that the suite takes as long as the person waited.
func TestATestRunThePersonStopsIsNotLearned(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a shell script stands in for go")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "go"), []byte("#!/bin/sh\necho running tests\nsleep 60\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	w, tools := bg(t)
	done := make(chan tool.Result, 1)
	go func() {
		done <- tools["run_command"].Run(context.Background(), tool.Context{CallID: "call-t"}, tool.Args{"command": "go test ./..."})
	}()
	a := activityOf(t, w, "call-t", func(a Activity) bool { return a.Pid > 0 && len(a.Tail) == 1 })
	if _, err := w.jobs.StopActivity(a.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("stop did not end the test run")
	}
	if data, err := os.ReadFile(filepath.Join(w.Root, ".archymedes", "test-times.json")); err == nil && strings.Contains(string(data), "./...") {
		t.Fatalf("a stopped run was learned as a timing:\n%s", data)
	}
}
