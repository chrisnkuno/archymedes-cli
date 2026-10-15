package project

import (
	"context"
	"strings"
)

// What /push and /pr need from git: where HEAD is, which branch is the default one, and the push.

// CurrentBranch is HEAD's branch, or "" when HEAD is detached.
func CurrentBranch(ctx context.Context, root string) (string, error) {
	out, err := git(ctx, root, "branch", "--show-current")
	return strings.TrimSpace(string(out)), err
}

// DefaultBranch is the remote's default branch (what origin/HEAD points at), or, without one, a
// local main or master. "" when none can be told.
func DefaultBranch(ctx context.Context, root string) string {
	remote := PushRemote(ctx, root)
	if remote != "" {
		if out, err := git(ctx, root, "symbolic-ref", "--short", "refs/remotes/"+remote+"/HEAD"); err == nil {
			return strings.TrimPrefix(strings.TrimSpace(string(out)), remote+"/")
		}
	}
	for _, name := range []string{"main", "master"} {
		if _, err := git(ctx, root, "rev-parse", "--verify", "-q", "refs/heads/"+name); err == nil {
			return name
		}
	}
	return ""
}

// PushRemote is the remote a push goes to: origin when there is one, else the first; "" for none.
func PushRemote(ctx context.Context, root string) string {
	out, err := git(ctx, root, "remote")
	if err != nil {
		return ""
	}
	remotes := strings.Fields(string(out))
	for _, r := range remotes {
		if r == "origin" {
			return r
		}
	}
	if len(remotes) > 0 {
		return remotes[0]
	}
	return ""
}

// NewBranch creates a branch at HEAD and switches to it, carrying uncommitted work along.
func NewBranch(ctx context.Context, root, name string) error {
	_, err := gitErr(ctx, root, "switch", "-c", name)
	return err
}

// Push pushes a branch to the push remote and sets it as the branch's upstream.
func Push(ctx context.Context, root, branch string) (string, error) {
	remote := PushRemote(ctx, root)
	if remote == "" {
		return "", errNoRemote
	}
	_, err := gitErr(ctx, root, "push", "--set-upstream", remote, branch)
	return remote, err
}

var errNoRemote = errorString("this repository has no remote to push to (git remote add origin <url>)")

type errorString string

func (e errorString) Error() string { return string(e) }
