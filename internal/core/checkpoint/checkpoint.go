// Package checkpoint is undo for an agent that edits real files: before every turn the workspace is
// snapshotted as a git tree, through a private index file, so /undo, /rewind and /diff can put the
// files back or show what a turn changed (ported from packages/core/src/cli/checkpoints.ts).
//
// The private index (GIT_INDEX_FILE) keeps it invisible: staging the workspace into Friday's own
// index never touches the person's staged changes. A snapshot costs one tree object, not a copy.
// .archymedes (sessions, this index) is left out of every snapshot, or restoring would delete the
// session along with the code.
package checkpoint

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Checkpoint is the workspace before one turn.
type Checkpoint struct {
	// Tree is the git tree object of the workspace at that moment.
	Tree      string    `json:"tree"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"createdAt"`
	// MessageCount is how long the conversation was; -1 once compaction summarized that point
	// away, when only the files can go back.
	MessageCount int `json:"messageCount"`
}

// exclude keeps Friday's own state out of every snapshot.
var exclude = []string{"--", ".", ":(exclude).archymedes"}

// Store is one session's checkpoints.
type Store struct {
	root    string // the project (a git working tree)
	dir     string // where the index and the list are kept (the session's folder)
	session string

	mu     sync.Mutex
	list   []Checkpoint
	seeded bool
}

// Open is a session's checkpoints; nil when root is not in a git working tree (no undo there).
func Open(root, dir, session string) *Store {
	if out, err := git(context.Background(), root, nil, "rev-parse", "--is-inside-work-tree"); err != nil || strings.TrimSpace(out) != "true" {
		return nil
	}
	s := &Store{root: root, dir: dir, session: session}
	if data, err := os.ReadFile(s.listFile()); err == nil {
		_ = json.Unmarshal(data, &s.list)
	}
	return s
}

func (s *Store) listFile() string  { return filepath.Join(s.dir, "checkpoints.json") }
func (s *Store) indexFile() string { return filepath.Join(s.dir, "checkpoint-index") }
func (s *Store) env() []string     { return []string{"GIT_INDEX_FILE=" + s.indexFile()} }

func (s *Store) save() {
	data, _ := json.Marshal(s.list)
	tmp := s.listFile() + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, s.listFile())
	}
}

// Capture snapshots the workspace before a turn. A failure (git missing, an odd repository) is no
// checkpoint, never a failed turn: losing undo costs comfort, not the task.
func (s *Store) Capture(ctx context.Context, label string, messageCount int) (Checkpoint, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return Checkpoint{}, false
	}
	seeded := s.seed(ctx)
	if _, err := git(ctx, s.root, s.env(), append([]string{"add", "--all"}, exclude...)...); err != nil {
		if !seeded {
			return Checkpoint{}, false
		}
		// A copied index git cannot use: start from empty.
		_ = os.Remove(s.indexFile())
		if _, err := git(ctx, s.root, s.env(), append([]string{"add", "--all"}, exclude...)...); err != nil {
			return Checkpoint{}, false
		}
	}
	tree, err := git(ctx, s.root, s.env(), "write-tree")
	tree = strings.TrimSpace(tree)
	if err != nil || tree == "" {
		return Checkpoint{}, false
	}
	c := Checkpoint{Tree: tree, Label: label, CreatedAt: time.Now(), MessageCount: messageCount}
	s.list = append(s.list, c)
	s.save()
	// The ref keeps the tree from git gc; losing it costs only an undo after a gc.
	_, _ = git(ctx, s.root, nil, "update-ref", fmt.Sprintf("refs/friday/checkpoints/%s/%d", s.session, len(s.list)-1), tree)
	return c, true
}

// seed copies the repository's own index the first time, so the first capture only hashes files
// that differ from it rather than the whole workspace.
func (s *Store) seed(ctx context.Context) bool {
	if s.seeded {
		return false
	}
	s.seeded = true
	if _, err := os.Stat(s.indexFile()); err == nil {
		return false
	}
	gitDir, err := git(ctx, s.root, nil, "rev-parse", "--git-dir")
	if err != nil {
		return false
	}
	gitDir = strings.TrimSpace(gitDir)
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(s.root, gitDir)
	}
	src, err := os.Open(filepath.Join(gitDir, "index"))
	if err != nil {
		return false
	}
	defer src.Close()
	dst, err := os.OpenFile(s.indexFile(), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return false
	}
	_, err = io.Copy(dst, src)
	dst.Close()
	if err != nil {
		_ = os.Remove(s.indexFile())
		return false
	}
	if _, err := git(ctx, s.root, s.env(), "rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ".archymedes"); err != nil {
		_ = os.Remove(s.indexFile())
		return false
	}
	return true
}

// restore puts the workspace back to a tree: files changed since are reverted, files created since
// removed (staging first makes them known to the index, so --reset removes them too).
func (s *Store) restore(ctx context.Context, tree string) error {
	if _, err := git(ctx, s.root, s.env(), append([]string{"add", "--all"}, exclude...)...); err != nil {
		return err
	}
	_, err := git(ctx, s.root, s.env(), "read-tree", "-u", "--reset", tree)
	return err
}

// List is every checkpoint, oldest first.
func (s *Store) List() []Checkpoint {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Checkpoint(nil), s.list...)
}

// Scope is what going back restores: the files, the conversation, or both.
type Scope string

const (
	Both         Scope = ""
	Code         Scope = "code"
	Conversation Scope = "conversation"
)

// Back goes to before turn index (the last one for /undo): the files are restored unless the scope
// is the conversation, and that checkpoint and every later one are dropped, so going back again
// reaches the turn before. It returns the checkpoint gone back to.
func (s *Store) Back(ctx context.Context, index int, scope Scope) (Checkpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if index < 0 || index >= len(s.list) {
		return Checkpoint{}, fmt.Errorf("no turn %d to go back to", index)
	}
	c := s.list[index]
	if scope != Conversation {
		if err := s.restore(ctx, c.Tree); err != nil {
			return Checkpoint{}, fmt.Errorf("the files could not be restored: %w", err)
		}
	}
	for i := index; i < len(s.list); i++ {
		_, _ = git(ctx, s.root, nil, "update-ref", "-d", fmt.Sprintf("refs/friday/checkpoints/%s/%d", s.session, i))
	}
	s.list = s.list[:index]
	s.save()
	return c, nil
}

// ForgetConversation marks every checkpoint as files-only: compaction rewrote the conversation, so
// its old lengths no longer point anywhere.
func (s *Store) ForgetConversation() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.list {
		s.list[i].MessageCount = -1
	}
	s.save()
}

// Diff is what changed since the last checkpoint: a patch, or with stat a summary per file.
func (s *Store) Diff(ctx context.Context, stat bool) string {
	s.mu.Lock()
	var last *Checkpoint
	if n := len(s.list); n > 0 {
		c := s.list[n-1]
		last = &c
	}
	s.mu.Unlock()
	if last == nil {
		return ""
	}
	format := []string{"--unified=3", "--no-color"}
	if stat {
		format = []string{"--stat"}
	}
	return s.diffWorkspace(ctx, last.Tree, format)
}

// TurnPatch is what one turn changed: its checkpoint against the next, or against the workspace
// for the last turn.
func (s *Store) TurnPatch(ctx context.Context, index int) string {
	s.mu.Lock()
	list := append([]Checkpoint(nil), s.list...)
	s.mu.Unlock()
	if index < 0 || index >= len(list) {
		return ""
	}
	if index == len(list)-1 {
		return s.diffWorkspace(ctx, list[index].Tree, []string{"--unified=3", "--no-color"})
	}
	out, err := git(ctx, s.root, nil, "diff", "--unified=3", "--no-color", list[index].Tree, list[index+1].Tree)
	if err != nil {
		return ""
	}
	return out
}

// diffWorkspace diffs a tree against the workspace through a throwaway index, so new files show and
// neither the person's staging nor the checkpoint index is touched.
func (s *Store) diffWorkspace(ctx context.Context, tree string, format []string) string {
	tmp, err := os.CreateTemp(s.dir, "diff-index-*")
	if err != nil {
		return ""
	}
	tmp.Close()
	_ = os.Remove(tmp.Name()) // git creates it
	defer os.Remove(tmp.Name())
	env := []string{"GIT_INDEX_FILE=" + tmp.Name()}
	if _, err := git(ctx, s.root, env, "read-tree", tree); err != nil {
		return ""
	}
	if _, err := git(ctx, s.root, env, append([]string{"add", "--all"}, exclude...)...); err != nil {
		return ""
	}
	out, err := git(ctx, s.root, env, append(append([]string{"diff", "--cached"}, format...), append([]string{tree}, exclude...)...)...)
	if err != nil {
		return ""
	}
	return out
}

func git(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return stdout.String(), fmt.Errorf("git %s: %v %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}
