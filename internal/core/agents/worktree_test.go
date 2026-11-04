package agents

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A project reached through a symlink (macOS keeps temp directories behind /var -> /private/var, and
// people link project folders) still gets its child worktree in the right place. git reports the
// repository's real path; the relative path between that and the symlinked project path used to be
// nonsense, so the child's directory was not a repository at all.
func TestAWorktreeIsFoundWhenTheProjectIsReachedThroughASymlink(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.MkdirAll(filepath.Join(real, "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		// Windows needs a privilege for symlinks; a directory junction needs none and resolves the same way.
		if out, jerr := exec.Command("cmd", "/c", "mklink", "/J", link, real).CombinedOutput(); jerr != nil {
			t.Skipf("cannot create a symlink or junction here: %v / %v %s", err, jerr, out)
		}
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = real
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@a")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	if err := os.WriteFile(filepath.Join(real, "pkg", "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "init")
	t.Setenv("XDG_CACHE_HOME", filepath.Join(base, "cache"))
	t.Setenv("HOME", filepath.Join(base, "home"))
	t.Setenv("LocalAppData", filepath.Join(base, "cache"))

	for i, root := range []string{link, filepath.Join(link, "pkg")} {
		s := &Session{cfg: Config{Root: root}}
		s.meta.ID = "s1"
		dir, branch, err := s.addWorktree(fmt.Sprintf("t-%d", i+1))
		if err != nil {
			t.Fatalf("%s: %v", root, err)
		}
		if _, err := s.gitIn(dir, "status", "--porcelain"); err != nil {
			t.Fatalf("%s: the child's directory %s is not a worktree: %v", root, dir, err)
		}
		if branch == "" {
			t.Fatalf("%s: no branch", root)
		}
	}
}
