package tui

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// branchedProject is a repository on main with a feature branch two commits ahead, a child
// agent's worktree with an edit in it, and one stash; its own working tree is clean.
func branchedProject(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Ada", "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=Ada", "GIT_COMMITTER_EMAIL=a@a")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	commit := func(file, content, message string) {
		t.Helper()
		os.WriteFile(filepath.Join(root, file), []byte(content), 0o644)
		git("add", file)
		git("commit", "-q", "-m", message)
	}
	git("init", "-q", "-b", "main")
	commit("app.go", "package app\n", "start the app")
	git("switch", "-q", "-c", "feature")
	commit("feature.go", "package app\n", "add the feature")
	commit("feature.go", "package app\n\n// done\n", "finish the feature")
	git("switch", "-q", "main")
	child := filepath.Join(root, ".archymedes", "children", "c-1")
	git("worktree", "add", "-q", "-b", "archy/c-1", child, "HEAD")
	os.WriteFile(filepath.Join(child, "app.go"), []byte("package app\n\nfunc Child() {}\n"), 0o644)
	os.WriteFile(filepath.Join(root, "app.go"), []byte("package app // stashed\n"), 0o644)
	git("stash", "push", "-q", "-m", "half done")
	return root
}

// selectUntil presses ↓ until the screen shows want, at most ten times.
func selectUntil(t *testing.T, m *Model, want string) string {
	t.Helper()
	for range 10 {
		if s := screen(m); strings.Contains(s, want) {
			return s
		}
		deliver(m, press(m, tea.KeyDown, 0))
	}
	t.Fatalf("never showed %q:\n%s", want, screen(m))
	return ""
}

func TestChangesShowsTheBranchesWorktreesAndStash(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 36})
	c := openChangesAt(t, m, branchedProject(t))
	if s := screen(m); !strings.Contains(s, "on main") || !strings.Contains(s, "Nothing has changed since the last commit") {
		t.Fatalf("files view:\n%s", s)
	}

	deliver(m, press(m, 'b', 0))
	if !c.showBranches {
		t.Fatal("b did not turn to Branches")
	}
	s := screen(m)
	for _, want := range []string{"Files · Branches", "Local 3", "* main", "feature", "Worktrees 2", "this checkout", ".archymedes/children/c-1", "agent", "Stash 1", "half done",
		"checked out here · no upstream", "start the app", "Ada"} {
		if !strings.Contains(s, want) {
			t.Errorf("Branches lacks %q:\n%s", want, s)
		}
	}

	// A branch: its graph, and where it stands against HEAD.
	s = selectUntil(t, m, "2 ahead of main")
	if !strings.Contains(s, "finish the feature") || !strings.Contains(s, "(feature)") {
		t.Errorf("feature's history:\n%s", s)
	}
	// The child's worktree: what changed in it.
	s = selectUntil(t, m, "on archy/c-1 ·")
	if !strings.Contains(s, "M app.go +2 −0") {
		t.Errorf("the child worktree's changes:\n%s", s)
	}
	// The stash: its patch.
	s = selectUntil(t, m, "stash@{0}")
	if !strings.Contains(s, "+package app // stashed") {
		t.Errorf("the stash's patch:\n%s", s)
	}
	assertFits(t, m, "changes")

	deliver(m, press(m, 'b', 0))
	if c.showBranches || !strings.Contains(screen(m), "Nothing has changed since the last commit") {
		t.Fatalf("b did not turn back to Files:\n%s", screen(m))
	}
}

func TestBranchesOutsideARepositorySaysSo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	openChangesAt(t, m, t.TempDir())
	deliver(m, press(m, 'b', 0))
	if s := screen(m); !strings.Contains(s, "not a git repository") {
		t.Fatalf("outside a repository:\n%s", s)
	}
}

func TestTrackTextAndAheadBehind(t *testing.T) {
	for _, tc := range []struct {
		ahead, behind int
		gone          bool
		track, words  string
	}{{0, 0, false, "", "0 behind"}, {2, 0, false, "↑2", "2 ahead of"}, {0, 3, false, "↓3", "3 behind"}, {1, 1, false, "↑1 ↓1", "1 ahead, 1 behind"}, {0, 0, true, "gone", "0 behind"}} {
		if got := trackText(tc.ahead, tc.behind, tc.gone); got != tc.track {
			t.Errorf("trackText(%d, %d, %v) = %q", tc.ahead, tc.behind, tc.gone, got)
		}
		if got := aheadBehind(tc.ahead, tc.behind); got != tc.words {
			t.Errorf("aheadBehind(%d, %d) = %q", tc.ahead, tc.behind, got)
		}
	}
}
