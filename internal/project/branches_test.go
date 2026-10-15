package project

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// branchedRepo is a clone of an origin, with: main one commit ahead of origin/main, a feature
// branch two commits off main, a child agent's worktree on its own branch, and one stash.
func branchedRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base := t.TempDir()
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Ada", "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=Ada", "GIT_COMMITTER_EMAIL=a@a")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	commit := func(dir, file, content, message string) {
		t.Helper()
		os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644)
		run(dir, "add", file)
		run(dir, "commit", "-q", "-m", message)
	}
	origin := filepath.Join(base, "origin")
	os.Mkdir(origin, 0o755)
	run(origin, "init", "-q", "-b", "main")
	commit(origin, "a.txt", "a\n", "first")
	root := filepath.Join(base, "work")
	run(base, "clone", "-q", origin, root)
	commit(root, "b.txt", "b\n", "local only")
	run(root, "switch", "-q", "-c", "feature")
	commit(root, "c.txt", "c\n", "feature one")
	commit(root, "c.txt", "c2\n", "feature two")
	run(root, "switch", "-q", "main")
	run(root, "worktree", "add", "-q", "-b", "archy/c-1", filepath.Join(root, ".archymedes", "children", "c-1"), "HEAD")
	os.WriteFile(filepath.Join(root, ".archymedes", "children", "c-1", "a.txt"), []byte("child edit\n"), 0o644)
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("stashed\n"), 0o644)
	run(root, "stash", "push", "-q", "-m", "half done")
	return root
}

func TestBranchesReadsHeadBranchesWorktreesAndTheStash(t *testing.T) {
	root := branchedRepo(t)
	repo, err := Branches(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if repo.Head != "main" || repo.Detached || repo.Upstream != "origin/main" || repo.Ahead != 1 || repo.Behind != 0 {
		t.Errorf("head = %q detached=%v upstream=%q ↑%d ↓%d, want main on origin/main ↑1", repo.Head, repo.Detached, repo.Upstream, repo.Ahead, repo.Behind)
	}
	if len(repo.Branches) == 0 || repo.Branches[0].Name != "main" || !repo.Branches[0].Current {
		t.Fatalf("the current branch does not lead: %+v", repo.Branches)
	}
	byName := map[string]Branch{}
	for _, b := range repo.Branches {
		byName[b.Name] = b
	}
	if f := byName["feature"]; f.Subject != "feature two" || f.Remote || f.Commit == "" || f.When.IsZero() {
		t.Errorf("feature = %+v", f)
	}
	if o := byName["origin/main"]; !o.Remote || o.Subject != "first" {
		t.Errorf("origin/main = %+v", o)
	}
	if _, ok := byName["origin/HEAD"]; ok {
		t.Error("origin/HEAD is a pointer, not a branch")
	}
	if c := byName["archy/c-1"]; !strings.HasSuffix(filepath.ToSlash(c.Worktree), ".archymedes/children/c-1") {
		t.Errorf("the child's branch does not say where it is checked out: %+v", c)
	}
	if len(repo.Worktrees) != 2 || !repo.Worktrees[0].Current || repo.Worktrees[0].Branch != "main" {
		t.Fatalf("worktrees = %+v", repo.Worktrees)
	}
	if w := repo.Worktrees[1]; !w.Agent || w.Current || w.Branch != "archy/c-1" {
		t.Errorf("child worktree = %+v", w)
	}
	if len(repo.Stashes) != 1 || repo.Stashes[0].Ref != "stash@{0}" || !strings.Contains(repo.Stashes[0].Subject, "half done") {
		t.Errorf("stash = %+v", repo.Stashes)
	}

	changes, err := WorktreeChanges(context.Background(), repo.Worktrees[1])
	if err != nil || len(changes) != 1 || changes[0].Path != "a.txt" || changes[0].Status != "modified" {
		t.Errorf("child worktree changes = %+v, %v", changes, err)
	}
	patch, _, err := StashPatch(context.Background(), root, "stash@{0}")
	if err != nil || !strings.Contains(patch, "+stashed") {
		t.Errorf("stash patch = %q, %v", patch, err)
	}
}

func TestBranchHistoryDrawsTheGraphAndCountsAgainstHead(t *testing.T) {
	root := branchedRepo(t)
	h, err := BranchHistory(context.Background(), root, "feature")
	if err != nil {
		t.Fatal(err)
	}
	if h.Ahead != 2 || h.Behind != 0 {
		t.Errorf("feature against main: ↑%d ↓%d, want ↑2", h.Ahead, h.Behind)
	}
	if len(h.Commits) < 4 {
		t.Fatalf("history = %+v", h.Commits)
	}
	top := h.Commits[0]
	if top.Subject != "feature two" || !strings.Contains(top.Refs, "feature") || top.Author != "Ada" || !strings.HasPrefix(top.Graph, "*") {
		t.Errorf("top commit = %+v", top)
	}
	h, err = BranchHistory(context.Background(), root, "origin/main")
	if err != nil || h.Ahead != 0 || h.Behind != 1 {
		t.Errorf("origin/main against main: ↑%d ↓%d (%v), want ↓1", h.Ahead, h.Behind, err)
	}
	if _, err := BranchHistory(context.Background(), root, "--output=/tmp/x"); err == nil {
		t.Error("an option passed as a ref was run")
	}
}

func TestParseTrack(t *testing.T) {
	for track, want := range map[string][3]int{"": {0, 0, 0}, "ahead 3": {3, 0, 0}, "behind 2": {0, 2, 0}, "ahead 1, behind 4": {1, 4, 0}, "gone": {0, 0, 1}} {
		a, b, gone := parseTrack(track)
		g := 0
		if gone {
			g = 1
		}
		if [3]int{a, b, g} != want {
			t.Errorf("parseTrack(%q) = %d %d %v", track, a, b, gone)
		}
	}
}
