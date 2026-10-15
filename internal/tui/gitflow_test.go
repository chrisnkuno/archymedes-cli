package tui

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// clonedRepo is a clone of a bare remote with one commit on main, as a real project looks.
func clonedRepo(t *testing.T) (clone, remote string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base := t.TempDir()
	remote, clone = filepath.Join(base, "remote.git"), filepath.Join(base, "clone")
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@a")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git(base, "init", "-q", "--bare", "-b", "main", remote)
	git(base, "clone", "-q", remote, clone)
	os.WriteFile(filepath.Join(clone, "a.txt"), []byte("a\n"), 0o644)
	git(clone, "add", ".")
	git(clone, "commit", "-q", "-m", "init")
	git(clone, "push", "-q", "origin", "main")
	git(clone, "remote", "set-head", "origin", "main")
	return clone, remote
}

func remoteBranches(t *testing.T, remote string) string {
	out, _ := exec.Command("git", "-C", remote, "branch", "--list").Output()
	return string(out)
}

func TestPushOnTheDefaultBranchOffersANewBranchFirst(t *testing.T) {
	clone, remote := clonedRepo(t)
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m.opts.Cwd = clone
	m.tr.add(&userItem{text: "Fix the login redirect bug"})
	submitCommand(m, "/push")
	g, ok := m.overlay.(*defaultBranchGuard)
	if !ok {
		t.Fatalf("on main, /push asks first:\n%s", screen(m))
	}
	if g.name.Value() != "archy/fix-the-login-redirect-bug" {
		t.Fatalf("the offered name comes from what was asked: %q", g.name.Value())
	}
	deliver(m, press(m, tea.KeyEnter, 0))
	if !strings.Contains(remoteBranches(t, remote), "archy/fix-the-login-redirect-bug") {
		t.Fatalf("the new branch was pushed: %s\n%s", remoteBranches(t, remote), screen(m))
	}
	if !strings.Contains(screen(m), "Pushed archy/fix-the-login-redirect-bug to origin") {
		t.Fatal(screen(m))
	}
	// Now on the new branch: /push goes straight through.
	submitCommand(m, "/push")
	if m.overlay != nil {
		t.Fatal("no guard off the default branch")
	}
}

func TestPushTheDefaultBranchItselfOnlyWhenChosen(t *testing.T) {
	clone, _ := clonedRepo(t)
	m, _ := newTestModel(t)
	m.opts.Cwd = clone
	submitCommand(m, "/push")
	deliver(m, press(m, tea.KeyDown, 0))
	deliver(m, press(m, tea.KeyEnter, 0))
	if !strings.Contains(screen(m), "Pushed main to origin") {
		t.Fatal(screen(m))
	}
	submitCommand(m, "/push")
	deliver(m, press(m, tea.KeyEscape, 0))
	if m.overlay != nil {
		t.Fatal("esc cancels")
	}
}

func TestPROpensThePullRequestThroughTheAgentAfterPushing(t *testing.T) {
	clone, _ := clonedRepo(t)
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "gh"), []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	exec.Command("git", "-C", clone, "switch", "-q", "-c", "feature").Run()
	m, agent := newTestModel(t)
	m.opts.Cwd = clone
	submitCommand(m, "/pr mention the issue number")
	agent.mu.Lock()
	defer agent.mu.Unlock()
	if len(agent.prompts) != 1 || !strings.Contains(agent.prompts[0], "gh pr create --base main --head feature") || !strings.Contains(agent.prompts[0], "Guidance from me: mention the issue number") || !strings.Contains(agent.prompts[0], "do not push") {
		t.Fatalf("prompts %q", agent.prompts)
	}
}

func TestPushWithoutARemoteSaysSo(t *testing.T) {
	m, _ := newTestModel(t)
	m.opts.Cwd = changedRepo(t)
	submitCommand(m, "/push")
	if !strings.Contains(screen(m), "no remote") {
		t.Fatal(screen(m))
	}
}
