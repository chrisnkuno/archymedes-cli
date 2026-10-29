package tui

import (
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/render"
)

// Background commands, as the interface follows them. The engine starts one with run_command
// (background: true) and the model reads it with command_output, stops it with stop_command and
// lists them with list_commands; every one of those results opens with the command's state
// ("cmd1 running · 2s · 40 bytes"). From those lines this keeps each command's state and the last
// line it printed, for the changes rail (chat_rail.go). Friday's calls and its sub-agents' both
// count: the engine shares one set of commands across the session.

// maxRailCommands is how many background commands the rail lists.
const maxRailCommands = 4

// bgCommand is one background command as last reported.
type bgCommand struct {
	id, command, status string
	last                string // the last line it printed, as last read
	seen                time.Time
}

func (c *bgCommand) running() bool { return c.status == "running" }

// commandTools are the calls whose results report background commands.
var commandTools = map[string]bool{"run_command": true, "command_output": true, "stop_command": true, "list_commands": true}

// noteCommands reads a finished call's result for background commands.
func (m *Model) noteCommands(name string, args map[string]any, result string) {
	if !commandTools[name] {
		return
	}
	if name == "run_command" && !strings.HasPrefix(result, "Started ") {
		return // a command run in the foreground: its card says everything
	}
	lines := strings.Split(result, "\n")
	for i, line := range lines {
		match := render.JobHeadline.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		c := m.command(match[1])
		c.status, c.seen = match[2], time.Now()
		switch name {
		case "run_command":
			c.command, _ = args["command"].(string)
			c.last = lastPrinted(lines[i+1:])
		case "command_output":
			if printed := lastPrinted(lines[i+1:]); printed != "" {
				c.last = printed
			}
		case "list_commands":
			if c.command == "" {
				if parts := strings.Split(line, " · "); len(parts) > 3 {
					c.command = strings.Join(parts[3:], " · ")
				}
			}
		}
	}
}

// command is the command with this id, added when it is new.
func (m *Model) command(id string) *bgCommand {
	for _, c := range m.rail.commands {
		if c.id == id {
			return c
		}
	}
	c := &bgCommand{id: id}
	m.rail.commands = append(m.rail.commands, c)
	return c
}

// lastPrinted is the last line of output in a result's body: not blank, not the engine's own
// bracketed notes ("[next: since=12]"), not its "(no new output)".
func lastPrinted(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "[") || strings.HasPrefix(line, "(no ") {
			continue
		}
		return line
	}
	return ""
}

// railCommands are the commands the rail lists: running ones first, then those ended most
// recently, at most maxRailCommands.
func (m *Model) railCommands() []*bgCommand {
	var running, ended []*bgCommand
	for i := len(m.rail.commands) - 1; i >= 0; i-- {
		if c := m.rail.commands[i]; c.running() {
			running = append(running, c)
		} else {
			ended = append(ended, c)
		}
	}
	all := append(running, ended...)
	return all[:min(len(all), maxRailCommands)]
}

// runningCommands counts the background commands still running.
func (m *Model) runningCommands() int {
	n := 0
	for _, c := range m.rail.commands {
		if c.running() {
			n++
		}
	}
	return n
}
