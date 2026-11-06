package tui

import (
	"encoding/json"
	"fmt"
	"image/color"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// The phone's controls beyond the basics: Friday's own commands from a palette, the queue worked as
// at the terminal, helpers stopped and told things, and the page drawn in this session's theme.

// phoneCommands are the commands the phone may run: each acts on the session or answers in the
// conversation. Those that open a window on the computer, leave Friday, or touch keys and settings
// stay at the computer. needsArg: without one it would open a picker the phone cannot see.
var phoneCommands = map[string]struct{ needsArg bool }{
	"compact": {}, "diff": {}, "cost": {}, "todos": {}, "context": {}, "btw": {needsArg: true}, "review": {}, "goal": {},
	"agent": {needsArg: true}, "ci": {}, "retry": {}, "continue": {}, "commit": {}, "push": {}, "pr": {}, "export": {},
	"rewind": {needsArg: true}, "model": {needsArg: true}, "plan": {}, "build": {}, "auto": {}, "defender": {},
	"mcp": {}, "skills": {}, "hooks": {}, "tools": {}, "lsp": {}, "memory": {}, "subagents": {}, "fork": {},
	"new": {}, "where": {}, "undo": {}, "cancel": {},
}

// linkCommands is the palette the phone shows: name, what it takes, and what it does.
func linkCommands() []map[string]any {
	out := []map[string]any{}
	for _, c := range commands {
		if p, ok := phoneCommands[c.name]; ok {
			out = append(out, map[string]any{"name": c.name, "args": c.args, "help": c.help, "needsArg": p.needsArg})
		}
	}
	return out
}

// linkSlash runs one of phoneCommands as if typed at the terminal.
func (m *Model) linkSlash(r linkRequest) tea.Cmd {
	p, ok := phoneCommands[r.Command]
	if !ok {
		m.linkAck(r.ID, false, "/"+r.Command+" is for the computer")
		return nil
	}
	arg := strings.TrimSpace(r.Arg)
	if p.needsArg && arg == "" {
		m.linkAck(r.ID, false, "/"+r.Command+" needs what to do, from the phone")
		return nil
	}
	for _, c := range commands {
		if c.name == r.Command {
			m.linkAck(r.ID, true, "/"+r.Command)
			return c.run(m, arg)
		}
	}
	m.linkAck(r.ID, false, "No /"+r.Command)
	return nil
}

// linkQueue works one queued message: up, down, drop, or send it into the turn now.
func (m *Model) linkQueue(r linkRequest) tea.Cmd {
	i := -1
	for k, q := range m.queue {
		if "q"+strconv.Itoa(q.id) == r.Item {
			i = k
		}
	}
	if i < 0 {
		m.linkAck(r.ID, false, "That message is no longer queued")
		return nil
	}
	switch r.Action {
	case "up":
		if i > 0 {
			m.queue[i-1], m.queue[i] = m.queue[i], m.queue[i-1]
		}
	case "down":
		if i < len(m.queue)-1 {
			m.queue[i+1], m.queue[i] = m.queue[i], m.queue[i+1]
		}
	case "drop":
		text := m.queue[i].text
		m.dropQueued(i)
		m.linkAck(r.ID, true, "Dropped: "+text)
		return nil
	case "send":
		if m.queue[i].sending {
			m.linkAck(r.ID, true, "On its way")
			return nil
		}
		if m.phase != busy {
			text := m.queue[i].text
			m.dropQueued(i)
			m.linkAck(r.ID, true, "Sent")
			return m.send(text)
		}
		m.linkAck(r.ID, true, "Into the turn now")
		return m.steerQueued(i)
	default:
		m.linkAck(r.ID, false, "A queued message goes up, down, now, or away")
		return nil
	}
	m.linkAck(r.ID, true, "Moved")
	return nil
}

// linkHelper stops a helper, or tells it something.
func (m *Model) linkHelper(r linkRequest) tea.Cmd {
	var card *toolItem
	for _, it := range m.tr.items {
		if t, ok := it.(*toolItem); ok && delegationTools[t.name] && agentID(t) == r.Helper {
			card = t
		}
	}
	if card == nil || r.Helper == "" {
		m.linkAck(r.ID, false, "No such helper")
		return nil
	}
	switch r.Action {
	case "stop":
		if !agentWorking(card) {
			m.linkAck(r.ID, false, "That helper has already finished")
			return nil
		}
		m.linkAck(r.ID, true, "Stopping "+subagentRole(card))
		return m.stopAgent(card)
	case "send":
		if r.Text == nil || strings.TrimSpace(*r.Text) == "" {
			m.linkAck(r.ID, false, "Nothing to tell it")
			return nil
		}
		m.linkAck(r.ID, true, "Told "+subagentRole(card))
		return m.sessionCommand("agent-send", r.Helper+" "+strings.TrimSpace(*r.Text))
	}
	m.linkAck(r.ID, false, "A helper can be stopped or told something")
	return nil
}

// linkTheme is this session's theme as the page paints with it.
func (m *Model) linkTheme() map[string]string {
	th := m.th
	return map[string]string{
		"primary": hexOf(th.Primary), "secondary": hexOf(th.Secondary), "accent": hexOf(th.Accent),
		"bg": hexOf(th.Bg), "surface": hexOf(th.Surface), "text": hexOf(th.Text), "muted": hexOf(th.Muted),
		"success": hexOf(th.Success), "warning": hexOf(th.Warning), "error": hexOf(th.Error), "border": hexOf(th.BorderColor),
		"light": strconv.FormatBool(th.Light),
	}
}

func hexOf(c color.Color) string {
	if c == nil {
		return "#808080"
	}
	r, g, b, _ := c.RGBA()
	return fmt.Sprintf("#%02x%02x%02x", r>>8, g>>8, b>>8)
}

// linkNotice tells the phone a line the terminal shows as a toast.
func (m *Model) linkNotice(text string) {
	if m.link == nil || m.link.phones == 0 {
		return
	}
	raw, _ := json.Marshal(map[string]any{"type": "notice", "text": m.linkText(text)})
	m.linkSend(raw)
}
