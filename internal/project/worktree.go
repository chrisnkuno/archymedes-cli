package project

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// A session of its own in a worktree of its own (Claude Code's --worktree, T3 Code's "new worktree"
// thread): a new branch checked out under .archymedes/worktrees/<name>, so the agent's edits there
// never touch the checkout the person is working in, and several sessions can run side by side.
// A project's .archymedes/setup.sh prepares each new one (installing dependencies, copying a .env):
// worktrees share the repository, not untracked files.

// SessionWorktreesDir is where session worktrees live, beside the child agents' own.
const SessionWorktreesDir = ".archymedes/worktrees"

// SetupScript is the project's worktree setup, run in each new worktree when it exists.
const SetupScript = ".archymedes/setup.sh"

var unsafeName = regexp.MustCompile(`[^a-z0-9._-]+`)

// WorktreeName makes a name git and a folder both accept; empty becomes a dated one.
func WorktreeName(name string, now time.Time) string {
	name = strings.Trim(unsafeName.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-"), "-.")
	if name == "" {
		return "session-" + now.Format("20060102-150405")
	}
	return name[:min(len(name), 48)]
}

// NewWorktree checks out a new branch archy/<name> from HEAD into .archymedes/worktrees/<name> of
// the repository's main checkout, and returns it. A name already taken is an error, never reused.
func NewWorktree(ctx context.Context, root, name string) (Worktree, error) {
	main, err := MainWorktree(ctx, root)
	if err != nil {
		return Worktree{}, err
	}
	path := filepath.Join(main, filepath.FromSlash(SessionWorktreesDir), name)
	if _, err := os.Stat(path); err == nil {
		return Worktree{}, fmt.Errorf("a worktree named %s already exists", name)
	}
	branch := "archy/" + name
	if _, err := gitErr(ctx, main, "worktree", "add", "-q", "-b", branch, path, "HEAD"); err != nil {
		return Worktree{}, err
	}
	return Worktree{Path: path, Branch: branch}, nil
}

// MainWorktree is the repository's main checkout, wherever root is inside it or its worktrees.
func MainWorktree(ctx context.Context, root string) (string, error) {
	out, err := git(ctx, root, "worktree", "list", "--porcelain")
	if err != nil {
		return "", err
	}
	trees := parseWorktrees(out, "")
	if len(trees) == 0 {
		return "", ErrNotRepository
	}
	return trees[0].Path, nil
}

// FindSetupScript is the main checkout's setup script, or "" when it has none.
func FindSetupScript(main string) string {
	path := filepath.Join(main, filepath.FromSlash(SetupScript))
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		return path
	}
	return ""
}

// gitErr is git with its error message on failure, which is what a person needs to read.
func gitErr(ctx context.Context, root string, args ...string) ([]byte, error) {
	out, err := gitWithStderr(ctx, root, args...)
	if err != nil {
		var detail *gitError
		if errors.As(err, &detail) && detail.stderr != "" {
			return out, errors.New(detail.stderr)
		}
	}
	return out, err
}
