package tui

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// Some commands are whole programs the agent already has: the settings menu, the updater, the
// provider report. Rather than re-implement them, the interface runs the agent's own command —
// handing it the terminal for an interactive one, or showing what it prints for a report.

type handoffDoneMsg struct {
	command string
	err     error
}

type reportReadyMsg struct {
	title, text string
	err         error
}

// handOff gives the terminal to `agent <args>` until it exits, then takes it back.
func (m *Model) handOff(command string, args ...string) tea.Cmd {
	if len(m.opts.AgentArgv) == 0 {
		return m.toast(toastWarn, "/"+command+" needs the agent's command line, which this session does not have")
	}
	if m.phase == busy {
		return m.toast(toastWarn, "/"+command+" between turns; esc stops this one")
	}
	argv := append(append([]string{}, m.opts.AgentArgv...), args...)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = m.opts.Cwd
	return tea.ExecProcess(cmd, func(err error) tea.Msg { return handoffDoneMsg{command, err} })
}

func (m *Model) handoffDone(msg handoffDoneMsg) tea.Cmd {
	if msg.err != nil {
		return m.toast(toastWarn, "/"+msg.command+": "+msg.err.Error())
	}
	if msg.command == "settings" {
		// The agent behind this session read its settings when it started.
		return m.toast(toastInfo, "Settings saved — they apply from the next session")
	}
	return nil
}

// report runs `agent <args>` without a terminal and shows what it printed as a block.
func (m *Model) report(title string, args ...string) tea.Cmd {
	if len(m.opts.AgentArgv) == 0 {
		return m.toast(toastWarn, "/"+title+" needs the agent's command line, which this session does not have")
	}
	argv := append(append([]string{}, m.opts.AgentArgv...), args...)
	dir := m.opts.Cwd
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
		cmd.Dir = dir
		// Without a terminal the agent lays reports out at 80 columns; the block truncates beyond that.
		cmd.Env = append(os.Environ(), "NO_COLOR=1")
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		err := cmd.Run()
		return reportReadyMsg{title, ansi.Strip(out.String()), err}
	}
}

func (m *Model) reportReady(msg reportReadyMsg) tea.Cmd {
	if msg.err != nil && msg.text == "" {
		return m.toast(toastWarn, "/"+msg.title+": "+msg.err.Error())
	}
	m.tr.add(&reportItem{title: msg.title, text: msg.text})
	m.tr.toBottom()
	return nil
}
