package tui

import (
	"fmt"
	"strings"
	"time"
)

// The rail's Running: every command at work this moment, Friday's own and its sub-agents', with
// who runs it and for how long. A background command has its own section (Commands) with what it
// last printed; this is the foreground ones, which until now showed only on their cards. A click
// on one opens it: Friday's on its card, a sub-agent's in the Inspector.

// maxRailRunning is how many running commands the rail lists before saying how many more.
const maxRailRunning = 5

// runningCommand is one command at work: who runs it, what, since when, and the card it is on.
type runningCommand struct {
	who, command string
	started      time.Time
	card         *toolItem // Friday's own call, or the delegation card of the sub-agent running it
}

// isCommand is whether a call runs a command in the foreground.
func isCommand(tool string, args map[string]any) bool {
	if tool != "run_command" {
		return false
	}
	background, _ := args["background"].(bool)
	return !background
}

// commandText is a call's command, on one line.
func commandText(args map[string]any) string {
	command, _ := args["command"].(string)
	return strings.Join(strings.Fields(command), " ")
}

// runningCommands are the commands at work now, oldest first: Friday's, then each sub-agent's.
func (m *Model) commandsAtWork() []runningCommand {
	var out []runningCommand
	for _, it := range m.tr.items {
		t, ok := it.(*toolItem)
		if !ok {
			continue
		}
		if !t.done && isCommand(t.name, t.args) {
			out = append(out, runningCommand{who: "friday", command: commandText(t.args), started: t.started, card: t})
		}
		if t.sub == nil || !delegationTools[t.name] || !agentWorking(t) {
			continue
		}
		for _, st := range t.sub.steps {
			if !st.done && !st.said && isCommand(st.tool, st.args) {
				out = append(out, runningCommand{who: subagentRole(t), command: commandText(st.args), started: st.started, card: t})
			}
		}
	}
	return out
}

// railRunningRows is the Running section: its title and a row per command (zone rail:run:i).
func (m *Model) railRunningRows(running []runningCommand, inner int) []string {
	th := m.th
	rows := []string{spread(th.Strong.Render("Running"), th.Faint.Render(plural(len(running), "command")), inner)}
	for i, c := range running {
		if i == maxRailRunning {
			rows = append(rows, th.Faint.Render(fmt.Sprintf("  … %d more", len(running)-i)))
			break
		}
		took := th.Faint.Render(" " + elapsed(time.Since(c.started)))
		if c.who == "friday" && c.card != nil {
			took = th.Faint.Render(" " + elapsed(time.Since(c.started)) + c.card.test.railNote(time.Since(c.started)))
		}
		who := th.SoftPill(c.who, th.Secondary)
		if c.who == "friday" {
			who = th.SoftPill(c.who, th.Primary)
		}
		rows = append(rows, mark(m.zones.frame, fmt.Sprintf("rail:run:%d", i), m.spin.View()+" "+who+" "+th.Body.Render("$ "+c.command)+took))
	}
	return rows
}
