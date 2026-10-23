// Package tools is the Go engine's built-in tools on a local workspace: files, search, commands,
// the plan checklist, and git. Names, arguments and result shapes follow the TypeScript agent's
// (packages/core/src/cli/tools.ts, tools-search.ts, tools-extra/git.ts), so prompts, role files and
// the interface's tool cards work the same on both engines.
package tools

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Workspace is the directory a session works in, and what its tools remember between calls.
type Workspace struct {
	Root string
	// Rules are the person's command rules (allow, ask, forbid), read when the session opens.
	Rules []policy.CommandRule
	// Todos is the session's checklist; sub-agents never get the tools that write it.
	Todos *TodoList

	mu sync.Mutex
	// seen is each file's content hash as Friday last read or wrote it: edit_file refuses to edit
	// a file that changed since, rather than overwrite what someone else just wrote.
	seen map[string][32]byte
	// written is every file written this session, so running one counts as exercising it.
	written map[string]bool
}

// NewWorkspace is a workspace at root.
func NewWorkspace(root string) *Workspace {
	return &Workspace{Root: root, Todos: &TodoList{}, seen: map[string][32]byte{}, written: map[string]bool{}}
}

// At is a workspace sharing this one's rules but rooted elsewhere (a sub-agent's worktree).
func (w *Workspace) At(root string) *Workspace {
	other := NewWorkspace(root)
	other.Rules = w.Rules
	other.Todos = w.Todos
	return other
}

var errOutside = errors.New("is outside the project")

// resolve turns a path argument into an absolute path inside the root, and its display form
// relative to the root. Absolute paths are accepted when they lie inside.
func (w *Workspace) resolve(path string) (abs, rel string, err error) {
	path = strings.TrimSpace(path)
	if path == "" {
		path = "."
	}
	if strings.HasPrefix(path, "~") {
		return "", "", fmt.Errorf("%s %w", path, errOutside)
	}
	if filepath.IsAbs(path) {
		abs = filepath.Clean(path)
	} else {
		abs = filepath.Join(w.Root, filepath.FromSlash(path))
	}
	rel, err = filepath.Rel(w.Root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("%s %w", path, errOutside)
	}
	// A symlink inside the project that points outside it is outside it.
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		rootReal, _ := filepath.EvalSymlinks(w.Root)
		if r, err := filepath.Rel(rootReal, real); err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			return "", "", fmt.Errorf("%s %w (through a link)", path, errOutside)
		}
	}
	return abs, filepath.ToSlash(rel), nil
}

func (w *Workspace) remember(rel string, content []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.seen[rel] = sha256.Sum256(content)
}

func (w *Workspace) markWritten(rel string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.written[rel] = true
}

// Written is a copy of the files written this session.
func (w *Workspace) Written() map[string]bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make(map[string]bool, len(w.written))
	for k := range w.written {
		out[k] = true
	}
	return out
}

// stale reports whether a file read before has changed since; a file never read is not stale.
func (w *Workspace) stale(rel string, content []byte) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	sum, ok := w.seen[rel]
	return ok && sum != sha256.Sum256(content)
}

// Builtins are every built-in tool on this workspace.
func (w *Workspace) Builtins() []*tool.Tool {
	return []*tool.Tool{
		w.readFile(), w.listFiles(), w.globFiles(), w.grepFiles(),
		w.writeFile(), w.editFile(),
		w.runCommand(),
		w.todoWrite(), w.todoRead(),
		w.gitStatus(), w.gitDiff(), w.gitLog(), w.gitShow(),
	}
}

func readText(abs string) ([]byte, error) {
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("is a directory; use list_files")
	}
	if info.Size() > 10<<20 {
		return nil, fmt.Errorf("is %d bytes; read part of it with offset and limit after checking its size, or search it with grep_files", info.Size())
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	if looksBinary(data) {
		return nil, errors.New("is a binary file")
	}
	return data, nil
}

func looksBinary(data []byte) bool {
	n := min(len(data), 8000)
	for _, b := range data[:n] {
		if b == 0 {
			return true
		}
	}
	return false
}
