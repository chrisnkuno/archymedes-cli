package project

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The repository beyond the working tree, as git sees it: where HEAD is, the branches, the
// worktrees checked out from the repository, and the stash — the Changes app's Branches view.
// Read-only, like the rest of this package.

// Repository is the shape of a repository at one moment.
type Repository struct {
	Head      string // the checked-out branch, or the short commit when HEAD is detached
	Detached  bool
	Upstream  string // the current branch's upstream, if it has one
	Ahead     int    // commits on HEAD its upstream lacks
	Behind    int    // commits on the upstream HEAD lacks
	Branches  []Branch
	Worktrees []Worktree
	Stashes   []Stash
}

// Branch is one local or remote branch. Local ones come first, the current one leading; each kind
// is most recently committed first.
type Branch struct {
	Name     string // "master", or "origin/master" for a remote branch
	Remote   bool
	Current  bool
	Commit   string // short hash of its tip
	Subject  string
	When     time.Time
	Upstream string
	Ahead    int    // against its upstream
	Behind   int    // against its upstream
	Gone     bool   // its upstream was deleted
	Worktree string // where it is checked out, when that is not this checkout
}

// Worktree is one checkout of the repository; the first is the main one.
type Worktree struct {
	Path     string
	Branch   string // empty when detached
	Commit   string // short hash
	Current  bool   // the checkout root is in
	Agent    bool   // a child agent's own, under .archymedes/children/
	Locked   bool
	Prunable bool // its folder is gone; `git worktree prune` clears it
}

// Stash is one stash entry, newest first.
type Stash struct {
	Ref     string // "stash@{0}"
	Subject string
	When    time.Time
}

// Commit is one row of a graph log: the graph drawn to its left, and the commit when the row has
// one (a row that only continues the graph has an empty Hash).
type Commit struct {
	Graph   string
	Hash    string
	Refs    string // "HEAD -> master, origin/master"
	Subject string
	Author  string
	When    time.Time
}

// History is one ref's recent commits, and where it stands against HEAD.
type History struct {
	Ahead   int // commits on the ref HEAD lacks
	Behind  int // commits on HEAD the ref lacks
	Commits []Commit
}

// MaxHistory bounds a history: the most recent commits are the ones worth reading here.
const MaxHistory = 200

// maxRemoteBranches bounds the remote list; a fork with thousands of branches is not a list to read.
const maxRemoteBranches = 200

const unit = "\x1f" // separates fields in git's formatted output

// Branches reads HEAD, the branches, the worktrees and the stash. Each part that git cannot read
// is left empty rather than failing the rest; only a folder that is not a repository is an error.
func Branches(ctx context.Context, root string) (Repository, error) {
	var repo Repository
	top, err := git(ctx, root, "rev-parse", "--show-toplevel")
	if err != nil {
		return repo, err
	}
	toplevel := strings.TrimSpace(string(top))
	if name, err := git(ctx, root, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		repo.Head = strings.TrimSpace(string(name))
	} else if hash, err := git(ctx, root, "rev-parse", "--short", "HEAD"); err == nil {
		repo.Head, repo.Detached = strings.TrimSpace(string(hash)), true
	}

	format := strings.Join([]string{"%(HEAD)", "%(refname)", "%(objectname:short)", "%(upstream:short)",
		"%(upstream:track,nobracket)", "%(worktreepath)", "%(committerdate:unix)", "%(contents:subject)"}, "%1f")
	var local, remote []Branch
	if out, err := git(ctx, root, "for-each-ref", "--sort=-committerdate", "--format="+format, "refs/heads", "refs/remotes"); err == nil {
		for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
			f := strings.Split(line, unit)
			if len(f) != 8 {
				continue
			}
			b := Branch{Current: f[0] == "*", Commit: f[2], Upstream: f[3], Subject: f[7], When: unixTime(f[6])}
			switch {
			case strings.HasPrefix(f[1], "refs/heads/"):
				b.Name = strings.TrimPrefix(f[1], "refs/heads/")
			case strings.HasPrefix(f[1], "refs/remotes/") && !strings.HasSuffix(f[1], "/HEAD"):
				if len(remote) >= maxRemoteBranches {
					continue
				}
				b.Name, b.Remote = strings.TrimPrefix(f[1], "refs/remotes/"), true
			default:
				continue
			}
			b.Ahead, b.Behind, b.Gone = parseTrack(f[4])
			if f[5] != "" && !samePath(f[5], toplevel) {
				b.Worktree = f[5]
			}
			switch {
			case b.Current:
				// The current branch leads: it is the one the rest are compared with.
				repo.Upstream, repo.Ahead, repo.Behind = b.Upstream, b.Ahead, b.Behind
				local = append([]Branch{b}, local...)
			case b.Remote:
				remote = append(remote, b)
			default:
				local = append(local, b)
			}
		}
	}
	repo.Branches = append(local, remote...)

	if out, err := git(ctx, root, "worktree", "list", "--porcelain"); err == nil {
		repo.Worktrees = parseWorktrees(out, toplevel)
	}
	if out, err := git(ctx, root, "stash", "list", "--format=%gd%x1f%ct%x1f%s"); err == nil {
		for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
			if f := strings.SplitN(line, unit, 3); len(f) == 3 {
				repo.Stashes = append(repo.Stashes, Stash{Ref: f[0], When: unixTime(f[1]), Subject: f[2]})
			}
		}
	}
	return repo, nil
}

// parseTrack reads %(upstream:track,nobracket): "ahead 1, behind 2", "ahead 1", "behind 2", "gone".
func parseTrack(track string) (ahead, behind int, gone bool) {
	for _, part := range strings.Split(track, ", ") {
		word, number, _ := strings.Cut(strings.TrimSpace(part), " ")
		n, _ := strconv.Atoi(number)
		switch word {
		case "ahead":
			ahead = n
		case "behind":
			behind = n
		case "gone":
			gone = true
		}
	}
	return ahead, behind, gone
}

// parseWorktrees reads `git worktree list --porcelain`: blocks of "key value" lines, blank-separated.
func parseWorktrees(out []byte, toplevel string) []Worktree {
	var trees []Worktree
	for _, block := range strings.Split(strings.TrimSpace(string(out)), "\n\n") {
		var w Worktree
		for _, line := range strings.Split(block, "\n") {
			key, value, _ := strings.Cut(line, " ")
			switch key {
			case "worktree":
				w.Path = value
			case "HEAD":
				w.Commit = value[:min(len(value), 7)]
			case "branch":
				w.Branch = strings.TrimPrefix(value, "refs/heads/")
			case "locked":
				w.Locked = true
			case "prunable":
				w.Prunable = true
			}
		}
		if w.Path == "" {
			continue
		}
		w.Current = samePath(w.Path, toplevel)
		w.Agent = strings.Contains(filepath.ToSlash(w.Path), "/.archymedes/children/")
		trees = append(trees, w)
	}
	return trees
}

// BranchHistory reads ref's recent commits as a graph, and how it stands against HEAD.
func BranchHistory(ctx context.Context, root, ref string) (History, error) {
	var h History
	if strings.HasPrefix(ref, "-") {
		return h, errors.New("not a ref: " + ref)
	}
	if counts, err := git(ctx, root, "rev-list", "--left-right", "--count", "HEAD..."+ref, "--"); err == nil {
		if f := strings.Fields(string(counts)); len(f) == 2 {
			h.Behind, _ = strconv.Atoi(f[0])
			h.Ahead, _ = strconv.Atoi(f[1])
		}
	}
	// \x1e marks where the commit starts after the graph; a row without it only carries the graph.
	out, err := git(ctx, root, "log", "--graph", "--color=never", "-n", strconv.Itoa(MaxHistory),
		"--format=%x1e%h%x1f%D%x1f%an%x1f%ct%x1f%s", ref, "--")
	if err != nil {
		return h, err
	}
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		graph, rest, found := strings.Cut(line, "\x1e")
		c := Commit{Graph: strings.TrimRight(graph, " ")}
		if found {
			if f := strings.SplitN(rest, unit, 5); len(f) == 5 {
				c.Graph = graph
				c.Hash, c.Refs, c.Author, c.When, c.Subject = f[0], f[1], f[2], unixTime(f[3]), f[4]
			}
		}
		h.Commits = append(h.Commits, c)
	}
	return h, nil
}

// StashPatch is one stash entry's patch; truncated as Diff is.
func StashPatch(ctx context.Context, root, ref string) (text string, truncated bool, err error) {
	if !strings.HasPrefix(ref, "stash@{") {
		return "", false, errors.New("not a stash: " + ref)
	}
	out, err := git(ctx, root, "stash", "show", "-p", "--no-color", ref)
	if err != nil {
		return "", false, err
	}
	if len(out) > MaxDiffBytes {
		return string(trimPartialRune(out[:MaxDiffBytes])), true, nil
	}
	return string(out), false, nil
}

// WorktreeChanges is what changed in another checkout; a folder that is gone says so.
func WorktreeChanges(ctx context.Context, w Worktree) ([]Change, error) {
	if _, err := os.Stat(w.Path); err != nil {
		return nil, err
	}
	return Changes(ctx, w.Path)
}

func unixTime(s string) time.Time {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	return time.Unix(n, 0)
}

// samePath compares two paths as places on disk, through symlinks (a temp folder on macOS is one).
func samePath(a, b string) bool {
	clean := func(p string) string {
		if real, err := filepath.EvalSymlinks(p); err == nil {
			p = real
		}
		return filepath.Clean(p)
	}
	return clean(a) == clean(b)
}
