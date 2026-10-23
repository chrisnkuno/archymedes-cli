package agents

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// A writable sub-agent in the background works in its own git worktree on its own branch: the
// parent keeps editing the main checkout meanwhile, and two agents editing one file at once
// silently overwrite each other (the collision child-session.ts was written after). Its work is
// committed on the branch when it ends, and the report says how to take it.

func (s *Session) gitIn(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

func (s *Session) inGitRepo() bool {
	_, err := s.gitIn(s.cfg.Root, "rev-parse", "--verify", "HEAD")
	return err == nil
}

// addWorktree checks out HEAD on a new branch in a directory outside the project.
func (s *Session) addWorktree(id string) (dir, branch string, err error) {
	top, err := s.gitIn(s.cfg.Root, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", "", err
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		cache = os.TempDir()
	}
	checkout := filepath.Join(cache, "friday", "worktrees", s.meta.ID, id)
	branch = "friday/" + id
	if err := os.MkdirAll(filepath.Dir(checkout), 0o700); err != nil {
		return "", "", err
	}
	if _, err := s.gitIn(top, "worktree", "add", "-q", "-b", branch, checkout, "HEAD"); err != nil {
		return "", "", err
	}
	// The project may be a subdirectory of the repository; the child works in the same one.
	rel, _ := filepath.Rel(top, s.cfg.Root)
	return filepath.Join(checkout, rel), branch, nil
}

// closeWorktree commits what the child changed on its branch and says how to take it.
func (s *Session) closeWorktree(c *child) string {
	dir := c.t.Worktree
	status, err := s.gitIn(dir, "status", "--porcelain")
	if err != nil {
		return "Its worktree could not be read: " + err.Error()
	}
	if status == "" {
		return fmt.Sprintf("It changed nothing on branch %s.", c.t.Branch)
	}
	if _, err := s.gitIn(dir, "add", "-A"); err != nil {
		return "Its changes could not be staged: " + err.Error()
	}
	message := "friday " + c.profile.Name + ": " + firstLine(c.t.Brief)
	if _, err := s.gitIn(dir, "-c", "user.name=Friday", "-c", "user.email=friday@localhost", "commit", "-q", "--no-verify", "-m", message); err != nil {
		return "Its changes could not be committed: " + err.Error()
	}
	stat, _ := s.gitIn(dir, "diff", "--stat", "HEAD~1", "HEAD")
	return fmt.Sprintf("Its changes are committed on branch %s (worktree %s), started from HEAD, so edits you had not committed are not in it:\n%s\nTake them with `git merge %s` (or cherry-pick), then `git worktree remove %s`.", c.t.Branch, dir, stat, c.t.Branch, dir)
}

func firstLine(text string) string {
	line := strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	if len(line) > 72 {
		line = line[:72]
	}
	return line
}
