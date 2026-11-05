package project

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpstreamIsWhatTheBranchLastPushedOrNothing(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base := t.TempDir()
	remote, clone := filepath.Join(base, "remote.git"), filepath.Join(base, "clone")
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git(base, "init", "-q", "--bare", "-b", "main", remote)
	git(base, "clone", "-q", remote, clone)
	os.WriteFile(filepath.Join(clone, "a.txt"), []byte("a\n"), 0o644)
	git(clone, "add", ".")
	git(clone, "commit", "-q", "-m", "init")
	ctx := context.Background()
	if got := Upstream(ctx, clone, "main"); got != "" {
		t.Fatalf("nothing pushed yet, so no upstream: %q", got)
	}
	git(clone, "push", "-q", "-u", "origin", "main")
	head := git(clone, "rev-parse", "HEAD")
	if got := Upstream(ctx, clone, "main"); got != head {
		t.Fatalf("upstream %q, want the pushed commit %q", got, head)
	}
	os.WriteFile(filepath.Join(clone, "a.txt"), []byte("b\n"), 0o644)
	git(clone, "commit", "-q", "-am", "local only")
	if got := Upstream(ctx, clone, "main"); got != head {
		t.Fatalf("a local commit is not the upstream: %q", got)
	}
	if got := Upstream(ctx, t.TempDir(), "main"); got != "" {
		t.Fatalf("outside a repository: %q", got)
	}
}
