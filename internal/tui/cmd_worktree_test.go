package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestWorktreeOpensANewSessionThereAfterTheSetupScriptAndBackReturns(t *testing.T) {
	root := changedRepo(t)
	os.MkdirAll(filepath.Join(root, ".archymedes"), 0o755)
	os.WriteFile(filepath.Join(root, ".archymedes", "setup.sh"), []byte(`echo "set up from $ARCHYMEDES_ROOT_PATH" > "$ARCHYMEDES_WORKTREE_PATH/ready.txt"; echo setup done`+"\n"), 0o644)
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	m.opts.Cwd = root
	m.notice(noticeInfo, "the old conversation")

	submitSlow(m, "/worktree feature x")
	deliver(m, nil)
	wt := filepath.Join(root, ".archymedes", "worktrees", "feature-x")
	agent.mu.Lock()
	cwds := append([]string(nil), agent.cwds...)
	agent.mu.Unlock()
	if len(cwds) == 0 || !samePath(cwds[len(cwds)-1], wt) {
		t.Fatalf("the new session opens in the worktree: %v", cwds)
	}
	ready, err := os.ReadFile(filepath.Join(wt, "ready.txt"))
	// The script runs under a POSIX shell: on Windows its path has forward slashes, and on macOS
	// the temp directory is behind a symlink (/var -> /private/var).
	realRoot, _ := filepath.EvalSymlinks(root)
	var sawRoot bool
	for _, candidate := range []string{root, realRoot, filepath.ToSlash(root), filepath.ToSlash(realRoot)} {
		sawRoot = sawRoot || (candidate != "" && strings.Contains(string(ready), "set up from "+candidate))
	}
	if err != nil || !sawRoot {
		t.Fatalf("setup.sh ran there with the main checkout's path: %q %v", ready, err)
	}
	s := screen(m)
	if strings.Contains(s, "the old conversation") || !strings.Contains(s, "archy/feature-x") || !strings.Contains(s, "setup done") {
		t.Fatalf("a fresh session that says where it is:\n%s", s)
	}
	if len(agent.closed) == 0 {
		t.Fatal("the old session is closed (it stays in /resume)")
	}

	submitSlow(m, "/worktree back")
	agent.mu.Lock()
	last := agent.cwds[len(agent.cwds)-1]
	agent.mu.Unlock()
	if !samePath(last, root) {
		t.Fatalf("back to the main checkout: %s", last)
	}
}

func TestWorktreeOutsideARepositorySaysSo(t *testing.T) {
	m, _ := newTestModel(t)
	m.opts.Cwd = t.TempDir()
	submitCommand(m, "/worktree x")
	if !strings.Contains(screen(m), "/worktree:") {
		t.Fatal(screen(m))
	}
}
