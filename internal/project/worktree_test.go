package project

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWorktreeNamesAreSafeAndDatedWhenEmpty(t *testing.T) {
	now := time.Date(2026, 10, 15, 9, 30, 0, 0, time.UTC)
	for in, want := range map[string]string{"": "session-20261015-093000", "Fix the Parser!": "fix-the-parser", "../../etc": "etc", "a/b c": "a-b-c"} {
		if got := WorktreeName(in, now); got != want {
			t.Errorf("WorktreeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNewWorktreeChecksOutABranchUnderArchymedesFromAnyCheckout(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@a")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run(root, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("a\n"), 0o644)
	run(root, "add", ".")
	run(root, "commit", "-q", "-m", "init")
	ctx := context.Background()

	w, err := NewWorktree(ctx, root, "feature-x")
	if err != nil {
		t.Fatal(err)
	}
	if w.Branch != "archy/feature-x" || !strings.HasSuffix(filepath.ToSlash(w.Path), ".archymedes/worktrees/feature-x") {
		t.Fatalf("%+v", w)
	}
	if _, err := os.Stat(filepath.Join(w.Path, "a.txt")); err != nil {
		t.Fatal("the worktree has the files")
	}
	// From inside the new worktree, the main checkout is still the main one, and a second worktree
	// goes beside the first, not inside it.
	if main, _ := MainWorktree(ctx, w.Path); !samePath(main, root) {
		t.Fatalf("main = %s", main)
	}
	second, err := NewWorktree(ctx, w.Path, "second")
	if err != nil || !samePath(filepath.Dir(second.Path), filepath.Dir(w.Path)) {
		t.Fatalf("%+v %v", second, err)
	}
	if _, err := NewWorktree(ctx, root, "feature-x"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("a taken name: %v", err)
	}
	if FindSetupScript(root) != "" {
		t.Fatal("no script yet")
	}
	os.MkdirAll(filepath.Join(root, ".archymedes"), 0o755)
	os.WriteFile(filepath.Join(root, SetupScript), []byte("echo hi\n"), 0o644)
	if FindSetupScript(root) == "" {
		t.Fatal("the script is found")
	}
}
