package tui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// Two apps that make the desktop behave like one: a task manager (what is running, and a way to stop
// it) and a notification center (what the toasts said before they faded).

// --- notification center ---

type note struct {
	at   time.Time
	kind toastKind
	text string
}

const maxNotes = 200

// remember keeps a toast in the history and counts it unread until the center is opened.
func (m *Model) remember(kind toastKind, text string) {
	m.notes = append(m.notes, note{at: time.Now(), kind: kind, text: text})
	if len(m.notes) > maxNotes {
		m.notes = m.notes[len(m.notes)-maxNotes:]
	}
	m.unread++
}

type notesApp struct{ cursor int }

func (n *notesApp) title() string { return "Notifications" }
func (n *notesApp) key() string   { return "notifications" }

func (n *notesApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		return true, nil
	case "up", "k":
		n.cursor = max(n.cursor-1, 0)
	case "down", "j":
		n.cursor = min(n.cursor+1, max(len(m.notes)-1, 0))
	case "c":
		m.notes, n.cursor = nil, 0
	}
	return false, nil
}

func (n *notesApp) view(m *Model) string {
	m.unread = 0
	th, width, height := m.th, m.width, max(m.windowHeight(), 1)
	lines := []string{" " + th.Strong.Render(fmt.Sprintf("%d notifications", len(m.notes))) + th.Faint.Render("   ↑/↓ move · c clear · esc close")}
	if len(m.notes) == 0 {
		lines = append(lines, "", " "+th.Faint.Render("Nothing yet. What the toasts say is kept here, newest first."))
		return strings.Join(fitLines(lines, width, height), "\n")
	}
	n.cursor = min(n.cursor, len(m.notes)-1)
	rows := max(height-2, 1)
	start := max(0, min(n.cursor-rows/2, len(m.notes)-rows))
	for i := start; i < min(start+rows, len(m.notes)); i++ {
		e := m.notes[len(m.notes)-1-i] // newest first
		mark, style := "  ", th.Body
		if e.kind == toastWarn {
			mark, style = "! ", th.Warn
		}
		line := th.Faint.Render(e.at.Format("15:04:05 ")) + style.Render(mark+e.text)
		if i == n.cursor {
			line = th.Title.Render("› ") + line
		} else {
			line = "  " + line
		}
		lines = append(lines, ansi.Truncate(" "+line, width, "…"))
	}
	return strings.Join(fitLines(lines, width, height), "\n")
}

// --- task manager ---

type tasksApp struct{ cursor int }

func (t *tasksApp) title() string { return "Tasks" }
func (t *tasksApp) key() string   { return "tasks" }

// taskRow is one line of the table: what it is, its state, how long, and what it was asked.
type taskRow struct {
	kind, state, detail string
	took                time.Duration
	failed              bool
}

// taskRows is the agent's turn, the prompts waiting behind it, then every tool call newest first.
func (m *Model) taskRows(now time.Time) []taskRow {
	var rows []taskRow
	switch m.phase {
	case busy:
		rows = append(rows, taskRow{kind: "turn", state: "running", took: now.Sub(m.turnStart), detail: firstLine(m.lastUserMessage())})
	case connecting:
		rows = append(rows, taskRow{kind: "agent", state: "starting"})
	case failed:
		rows = append(rows, taskRow{kind: "agent", state: "stopped", failed: true})
	default:
		rows = append(rows, taskRow{kind: "agent", state: "idle", detail: m.session.Info.Model})
	}
	for _, q := range m.queue {
		rows = append(rows, taskRow{kind: "queued", state: "waiting", detail: firstLine(q)})
	}
	for i := len(m.tr.items) - 1; i >= 0; i-- {
		t, ok := m.tr.items[i].(*toolItem)
		if !ok {
			continue
		}
		row := taskRow{kind: "tool", detail: t.name + " " + toolBrief(t)}
		switch {
		case t.denied:
			row.state, row.failed = "denied", true
		case !t.done:
			row.state, row.took = "running", now.Sub(t.started)
		case t.isError:
			row.state, row.failed, row.took = "failed", true, t.ended.Sub(t.started)
		default:
			row.state, row.took = "done", t.ended.Sub(t.started)
		}
		rows = append(rows, row)
	}
	return rows
}

// toolBrief is the one argument that says what a call is about.
func toolBrief(t *toolItem) string {
	for _, k := range []string{"command", "path", "pattern", "query", "id", "url"} {
		if v, ok := t.args[k].(string); ok && v != "" {
			return firstLine(v)
		}
	}
	return ""
}

func (t *tasksApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		return true, nil
	case "up", "k":
		t.cursor = max(t.cursor-1, 0)
	case "down", "j":
		t.cursor++
	case "x", "delete":
		if m.phase == busy {
			return false, tea.Batch(m.cancelTurn(), m.toast(toastInfo, "Stopping the running turn"))
		}
		return false, m.toast(toastInfo, "Nothing is running")
	case "enter":
		m.active = 0
		return false, nil
	}
	return false, nil
}

func (t *tasksApp) view(m *Model) string {
	th, width, height := m.th, m.width, max(m.windowHeight(), 1)
	rows := m.taskRows(time.Now())
	t.cursor = min(t.cursor, len(rows)-1)
	running := 0
	for _, r := range rows {
		if r.state == "running" {
			running++
		}
	}
	head := fmt.Sprintf("%d running · %d tools this session · %s in / %s out", running, m.stats.toolCount(), compact(m.usage.input), compact(m.usage.output))
	lines := []string{" " + th.Faint.Render(m.limitDetail()), " " + th.Strong.Render(head) + th.Faint.Render("   ↑/↓ move · x stop the turn · enter chat · esc close"),
		" " + th.Faint.Render(padRight("TASK", 8)+padRight("STATE", 10)+padRight("TIME", 8)+"WHAT")}
	visible := max(height-3, 1)
	start := max(0, min(t.cursor-visible/2, len(rows)-visible))
	for i := start; i < min(start+visible, len(rows)); i++ {
		r := rows[i]
		state := th.Body
		switch {
		case r.failed:
			state = th.Bad
		case r.state == "running" || r.state == "starting":
			state = th.Highlight
		case r.state == "done" || r.state == "idle":
			state = th.OK
		}
		took := ""
		if r.took > 0 {
			took = elapsed(r.took)
		}
		line := th.Body.Render(padRight(r.kind, 8)) + state.Render(padRight(r.state, 10)) + th.Faint.Render(padRight(took, 8)) + th.Body.Render(r.detail)
		if i == t.cursor {
			line = th.Title.Render("›") + line
		} else {
			line = " " + line
		}
		lines = append(lines, ansi.Truncate(line, width, "…"))
	}
	return strings.Join(fitLines(lines, width, height), "\n")
}
