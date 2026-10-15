package tui

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/archymedes-cli/internal/project"
)

// /worktree [name]: a new session in a new worktree — a branch of its own, checked out under
// .archymedes/worktrees/, so the agent's edits there never touch the checkout the person works in.
// The project's .archymedes/setup.sh runs in it first, shown in the new session. /worktree back
// returns to the main checkout. The session left behind is saved and stays in /resume.

type worktreeMadeMsg struct {
	path, branch, main, setup string
	err                       error
}

type worktreeBackMsg struct {
	main string
	err  error
}

func (m *Model) cmdWorktree(arg string) tea.Cmd {
	if m.phase == busy {
		return m.toast(toastWarn, "/worktree between turns; esc stops this one")
	}
	root := m.projectRoot()
	if strings.TrimSpace(arg) == "back" {
		return func() tea.Msg {
			main, err := project.MainWorktree(context.Background(), root)
			return worktreeBackMsg{main, err}
		}
	}
	name := project.WorktreeName(arg, time.Now())
	return tea.Batch(m.toast(toastInfo, "Creating worktree "+name+"…"), func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		main, err := project.MainWorktree(ctx, root)
		if err != nil {
			return worktreeMadeMsg{err: err}
		}
		w, err := project.NewWorktree(ctx, root, name)
		if err != nil {
			return worktreeMadeMsg{err: err}
		}
		return worktreeMadeMsg{path: w.Path, branch: w.Branch, main: main, setup: project.FindSetupScript(main)}
	})
}

func (m *Model) worktreeMade(msg worktreeMadeMsg) tea.Cmd {
	if msg.err != nil {
		return m.toast(toastWarn, "/worktree: "+msg.err.Error())
	}
	open := m.moveSession(msg.path)
	m.notice(noticeInfo, "A new session on branch "+msg.branch+", in "+relativeTo(msg.main, msg.path)+". /worktree back returns to the main checkout.")
	if msg.setup == "" {
		return open
	}
	env := []string{"ARCHYMEDES_ROOT_PATH=" + msg.main, "ARCHYMEDES_WORKTREE_PATH=" + msg.path}
	return tea.Batch(open, m.runShellIn("sh "+shellQuote(msg.setup), msg.path, env))
}

func (m *Model) worktreeBack(msg worktreeBackMsg) tea.Cmd {
	switch {
	case msg.err != nil:
		return m.toast(toastWarn, "/worktree back: "+msg.err.Error())
	case samePath(msg.main, m.projectRoot()):
		return m.toast(toastInfo, "This is the main checkout already")
	}
	return m.moveSession(msg.main)
}

// moveSession closes this session (it is saved; /resume lists it) and opens a new one in dir.
func (m *Model) moveSession(dir string) tea.Cmd {
	agent, previous := m.agent, m.session.ID
	m.tr.clear()
	m.tools, m.current = map[string]*toolItem{}, nil
	m.opts.Cwd, m.opts.Resume = dir, ""
	m.session.Info.Root = ""
	return tea.Batch(func() tea.Msg {
		if previous != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = agent.CloseSession(ctx, previous)
		}
		return nil
	}, m.openSession())
}

func relativeTo(base, path string) string {
	if rel, err := filepath.Rel(base, path); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}
	return path
}

func samePath(a, b string) bool {
	ea, errA := filepath.EvalSymlinks(a)
	eb, errB := filepath.EvalSymlinks(b)
	if errA == nil && errB == nil {
		return ea == eb
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// shellQuote quotes a path for sh.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
