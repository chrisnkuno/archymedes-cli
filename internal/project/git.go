package project

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

// What changed in the working tree, as git sees it: the Changes app's file list and the diff of
// one file. Read-only, like the rest of this package.

// Change is one changed path: its status, and how many lines were added and removed (both 0 for a
// binary file, which Binary marks).
type Change struct {
	Path    string
	From    string // the old path of a rename
	Status  string // "modified", "added", "deleted", "renamed", "untracked", "conflict"
	Staged  bool   // the change is in the index (some of it may also be unstaged)
	Added   int
	Removed int
	Binary  bool
}

// ErrNotRepository is returned outside a git repository.
var ErrNotRepository = errors.New("not a git repository")

// MaxDiffBytes bounds one file's diff: past it the view says so rather than drawing a novel.
const MaxDiffBytes = 1 << 20

func git(ctx context.Context, root string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "core.quotepath=off", "--no-optional-locks"}, args...)...)
	cmd.Dir = root
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil && strings.Contains(stderr.String(), "not a git repository") {
		return nil, ErrNotRepository
	}
	return out, err
}

// Changes lists the working tree's changes against HEAD, staged and unstaged together, sorted by
// path. A repository with no commits yet compares against the empty tree.
func Changes(ctx context.Context, root string) ([]Change, error) {
	out, err := git(ctx, root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	byPath := map[string]*Change{}
	var order []string
	fields := bytes.Split(out, []byte{0})
	for i := 0; i < len(fields); i++ {
		entry := string(fields[i])
		if len(entry) < 4 {
			continue
		}
		x, y, path := entry[0], entry[1], entry[3:]
		c := &Change{Path: path, Staged: x != ' ' && x != '?'}
		switch {
		case x == '?':
			c.Status = "untracked"
		case x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D'):
			c.Status = "conflict"
		case x == 'R' || y == 'R':
			c.Status = "renamed"
			if i+1 < len(fields) {
				c.From = string(fields[i+1]) // -z puts a rename's source in the next field
				i++
			}
		case x == 'A':
			c.Status = "added"
		case x == 'D' || y == 'D':
			c.Status = "deleted"
		default:
			c.Status = "modified"
		}
		byPath[path] = c
		order = append(order, path)
	}
	// Line counts: everything since HEAD (staged and not), plus untracked files counted whole.
	base := "HEAD"
	if _, err := git(ctx, root, "rev-parse", "--verify", "--quiet", "HEAD"); err != nil {
		base = emptyTree
	}
	if numstat, err := git(ctx, root, "diff", "--numstat", "-z", "-M", base); err == nil {
		applyNumstat(numstat, byPath)
	}
	for _, path := range order {
		if c := byPath[path]; c.Status == "untracked" {
			if numstat, err := git(ctx, root, "diff", "--no-index", "--numstat", "-z", "--", "/dev/null", path); len(numstat) > 0 || err == nil {
				applyNumstatTo(numstat, c)
			}
		}
	}
	sort.Strings(order)
	changes := make([]Change, 0, len(order))
	for _, path := range order {
		changes = append(changes, *byPath[path])
	}
	return changes, nil
}

// emptyTree is git's well-known empty tree, the base of a repository with no commits.
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// applyNumstat reads `git diff --numstat -z`: "added\tremoved\tpath\0", or for a rename
// "added\tremoved\t\0from\0to\0".
func applyNumstat(out []byte, byPath map[string]*Change) {
	fields := bytes.Split(out, []byte{0})
	for i := 0; i < len(fields); i++ {
		parts := strings.SplitN(string(fields[i]), "\t", 3)
		if len(parts) != 3 {
			continue
		}
		path := parts[2]
		if path == "" && i+2 < len(fields) {
			path = string(fields[i+2])
			i += 2
		}
		if c, ok := byPath[path]; ok {
			setCounts(c, parts[0], parts[1])
		}
	}
}

func applyNumstatTo(out []byte, c *Change) {
	for _, field := range bytes.Split(out, []byte{0}) {
		if parts := strings.SplitN(string(field), "\t", 3); len(parts) == 3 {
			setCounts(c, parts[0], parts[1])
			return
		}
	}
}

func setCounts(c *Change, added, removed string) {
	if added == "-" {
		c.Binary = true
		return
	}
	c.Added, _ = strconv.Atoi(added)
	c.Removed, _ = strconv.Atoi(removed)
}

// Diff is one changed file's unified diff against HEAD (staged and unstaged together); an
// untracked file is shown as entirely added. truncated is true when MaxDiffBytes cut it short.
func Diff(ctx context.Context, root string, c Change) (text string, truncated bool, err error) {
	var out []byte
	if c.Status == "untracked" {
		// --no-index exits 1 when the files differ, which for a new file they always do.
		out, err = git(ctx, root, "diff", "--no-index", "--no-color", "--", "/dev/null", c.Path)
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 {
			err = nil
		}
	} else {
		base := "HEAD"
		if _, headErr := git(ctx, root, "rev-parse", "--verify", "--quiet", "HEAD"); headErr != nil {
			base = emptyTree
		}
		args := []string{"diff", "--no-color", "-M", base, "--"}
		if c.From != "" {
			args = append(args, c.From)
		}
		out, err = git(ctx, root, append(args, c.Path)...)
	}
	if err != nil {
		return "", false, err
	}
	if len(out) > MaxDiffBytes {
		return string(trimPartialRune(out[:MaxDiffBytes])), true, nil
	}
	return string(out), false, nil
}
