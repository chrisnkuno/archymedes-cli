package tui

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// What a developer reaches for without wanting to ask the agent: run a command (!), open a file in
// their editor (/open), start over (/new), and have the changes committed (/commit). Plus one-key
// undo, retry and copy (core_keys.go).

// --- !command: the shell, directly ---

const (
	shellTimeout   = 2 * time.Minute
	shellMaxOutput = 256 * 1024
	shellShownTail = 40 // lines shown folded; ctrl+o shows all
)

// shellItem is a command run from the composer and its output, in the transcript. It is not sent to
// the agent: it is the person's own terminal, inside the session.
type shellItem struct {
	versioned
	command  string
	output   string
	done     bool
	exitCode int
	err      string
	took     time.Duration
}

func (s *shellItem) render(ctx renderCtx) []string {
	th := ctx.th
	head := th.Key.Render("$ ") + th.Strong.Render(s.command)
	switch {
	case !s.done:
		head += th.Faint.Render("  running… (esc stops it)")
	case s.err != "":
		head += "  " + th.Bad.Render(s.err)
	case s.exitCode == 0:
		head += "  " + th.OK.Render("✓") + th.Faint.Render(" "+elapsed(s.took))
	default:
		head += "  " + th.Bad.Render(fmt.Sprintf("exit %d", s.exitCode)) + th.Faint.Render(" "+elapsed(s.took))
	}
	lines := []string{ansi.Truncate(head, ctx.width, "…")}
	out := strings.Split(strings.TrimRight(s.output, "\n"), "\n")
	if strings.TrimSpace(s.output) == "" {
		out = nil
	}
	if !ctx.expanded && len(out) > shellShownTail {
		lines = append(lines, th.Faint.Render(fmt.Sprintf("  … %d earlier lines (ctrl+o shows all)", len(out)-shellShownTail)))
		out = out[len(out)-shellShownTail:]
	}
	for _, line := range out {
		lines = append(lines, "  "+ansi.Truncate(line, max(ctx.width-2, 4), "…"))
	}
	return lines
}

type shellDoneMsg struct {
	item     *shellItem
	output   string
	exitCode int
	err      error
	took     time.Duration
}

// runShell runs one command in the project root, the way the person's own shell would, and puts its
// output in the transcript. One at a time; esc stops it.
func (m *Model) runShell(command string) tea.Cmd {
	command = strings.TrimSpace(command)
	if command == "" {
		return m.toast(toastInfo, "!<command> runs it here, e.g. !git status")
	}
	return m.runShellIn(command, m.projectRoot(), nil)
}

// runShellIn is runShell in another folder, with more environment (a worktree's setup script).
func (m *Model) runShellIn(command, dir string, env []string) tea.Cmd {
	if m.shellCancel != nil {
		return m.toast(toastWarn, "A command is still running; esc stops it")
	}
	item := &shellItem{command: command}
	m.tr.add(item)
	m.stopScroll()
	m.tr.toBottom()
	ctx, cancel := context.WithTimeout(context.Background(), shellTimeout)
	m.shellCancel = cancel
	return func() tea.Msg {
		defer cancel()
		started := time.Now()
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(ctx, "cmd", "/C", command)
		} else {
			shell := os.Getenv("SHELL")
			if shell == "" {
				shell = "sh"
			}
			cmd = exec.CommandContext(ctx, shell, "-c", command)
		}
		cmd.Dir = dir
		cmd.Env = append(append(os.Environ(), "NO_COLOR=1", "TERM=dumb"), env...)
		var out limitedBuffer
		cmd.Stdout, cmd.Stderr = &out, &out
		err := cmd.Run()
		exit := 0
		var exitErr *exec.ExitError
		switch {
		// The context first: a command that was stopped also reports a (signal) exit code.
		case ctx.Err() == context.DeadlineExceeded:
			err = fmt.Errorf("stopped after %s", shellTimeout)
		case ctx.Err() == context.Canceled:
			err = errors.New("stopped")
		case errors.As(err, &exitErr):
			exit, err = exitErr.ExitCode(), nil
		}
		return shellDoneMsg{item: item, output: ansi.Strip(out.String()), exitCode: exit, err: err, took: time.Since(started)}
	}
}

func (m *Model) shellDone(msg shellDoneMsg) tea.Cmd {
	m.shellCancel = nil
	msg.item.done, msg.item.output, msg.item.exitCode, msg.item.took = true, msg.output, msg.exitCode, msg.took
	if msg.err != nil {
		msg.item.err = msg.err.Error()
	}
	msg.item.touch()
	return nil
}

// stopShell is esc while a command runs.
func (m *Model) stopShell() bool {
	if m.shellCancel == nil {
		return false
	}
	m.shellCancel()
	return true
}

// limitedBuffer keeps the last shellMaxOutput bytes: a command that prints forever must not eat memory.
type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n, err := b.Buffer.Write(p)
	if over := b.Len() - shellMaxOutput; over > 0 {
		b.Next(over)
	}
	return n, err
}

// --- /open: a file in the person's editor ---

type openedMsg struct{ err error }

// cmdOpen opens a project file in $VISUAL/$EDITOR, at a line when one is given ("src/app.ts:42").
func (m *Model) cmdOpen(arg string) tea.Cmd {
	arg = strings.TrimPrefix(strings.TrimSpace(arg), "@")
	if arg == "" {
		return m.toast(toastInfo, "/open <path>[:line] opens it in your editor")
	}
	editor := firstNonEmpty(os.Getenv("VISUAL"), os.Getenv("EDITOR"))
	if editor == "" {
		return m.toast(toastWarn, "Set $EDITOR (or $VISUAL) to use /open")
	}
	file, line := splitLine(arg)
	path := file
	if !filepath.IsAbs(path) {
		path = filepath.Join(m.projectRoot(), file)
	}
	if _, err := os.Stat(path); err != nil {
		return m.toast(toastWarn, file+" does not exist")
	}
	parts := strings.Fields(editor)
	args := append(parts[1:], editorArgs(filepath.Base(parts[0]), path, line)...)
	return tea.ExecProcess(exec.Command(parts[0], args...), func(err error) tea.Msg { return openedMsg{err} })
}

// splitLine separates "path:42" into the path and the line, leaving a path with no line alone.
func splitLine(arg string) (string, int) {
	if i := strings.LastIndex(arg, ":"); i > 0 {
		if n, err := strconv.Atoi(arg[i+1:]); err == nil && n > 0 {
			return arg[:i], n
		}
	}
	return arg, 0
}

// editorArgs is how each common editor is told to open a file at a line.
func editorArgs(editor, path string, line int) []string {
	if line <= 0 {
		return []string{path}
	}
	switch strings.TrimSuffix(editor, ".exe") {
	case "code", "code-insiders", "cursor", "codium", "windsurf":
		return []string{"--goto", fmt.Sprintf("%s:%d", path, line)}
	case "vim", "nvim", "vi", "nano", "emacs", "micro", "kak", "hx", "helix", "joe", "ne":
		return []string{fmt.Sprintf("+%d", line), path}
	case "subl", "zed":
		return []string{fmt.Sprintf("%s:%d", path, line)}
	}
	return []string{path}
}

// --- /new and /commit ---

// cmdNew starts a fresh session in the same project; the one being left is saved and can be resumed.
func (m *Model) cmdNew(string) tea.Cmd {
	if m.phase == busy {
		return m.toast(toastWarn, "Start a new session between turns; esc stops this one")
	}
	if m.agent == nil || m.session.ID == "" {
		return m.toast(toastWarn, "The session is not open yet")
	}
	m.stats, m.usage = newSessionStats(), usageTotals{}
	return tea.Batch(m.resumeSession(""), m.toast(toastInfo, "New session · the previous one is in /resume"))
}

const commitPrompt = "Commit the current changes. Look at `git status` and `git diff` first; make one commit, or a few if the changes are clearly separate, each with a short imperative subject and a body that says why. Do not push, and do not commit secrets, build output or files that look unrelated — list those instead."

func (m *Model) cmdCommit(arg string) tea.Cmd {
	prompt := commitPrompt
	if arg != "" {
		prompt += " Guidance from me: " + arg
	}
	return m.sendPrompt(prompt)
}
