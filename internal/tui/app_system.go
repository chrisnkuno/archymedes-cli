package tui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
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

type notesApp struct{ list listView }

func (n *notesApp) title() string { return "Notifications" }
func (n *notesApp) key() string   { return "notifications" }

// noteAt is the i-th notification shown, newest first.
func (m *Model) noteAt(i int) note { return m.notes[len(m.notes)-1-i] }

func (n *notesApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		return true, nil
	case "c":
		m.notes, n.list.cursor = nil, 0
	case "enter":
		// The whole of it, in a reader: a toast is cut to one line, this is not.
		if len(m.notes) > 0 {
			e := m.noteAt(n.list.cursor)
			m.openWindow(newPager(m, "notification "+e.at.Format("15:04:05"), strings.Split(e.text, "\n")))
		}
	default:
		n.list.move(msg.String(), len(m.notes))
	}
	return false, nil
}

func (n *notesApp) wheel(m *Model, up bool) tea.Cmd {
	n.list.wheel(up, len(m.notes))
	return nil
}

func (n *notesApp) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	if i, ok := n.list.clicked(m.zones.frame, msg, len(m.notes)); ok && n.list.clickRow(i) {
		_, cmd := n.handle(m, keyPress("enter"))
		return cmd
	}
	return nil
}

func (n *notesApp) view(m *Model) string {
	m.unread = 0
	th, width, height := m.th, m.width, max(m.windowHeight(), 1)
	n.list.zone = "note"
	lines := []string{" " + th.Strong.Render(fmt.Sprintf("%d notifications", len(m.notes)))}
	if len(m.notes) == 0 {
		lines = append(lines, "", " "+th.Faint.Render("Nothing yet. What the toasts say is kept here, newest first."))
	}
	from, to := n.list.window(len(m.notes), max(height-2, 1))
	for i := from; i < to; i++ {
		e := m.noteAt(i)
		mark, style := "  ", th.Body
		if e.kind == toastWarn {
			mark, style = "! ", th.Warn
		}
		lines = append(lines, n.list.row(m, m.zones.frame, i, " "+th.Faint.Render(e.at.Format("15:04:05 "))+style.Render(mark+e.text), width))
	}
	lines = fitLines(lines, width, height-1)
	return strings.Join(append(lines, m.hintBar(width, button{"enter", "read"}, button{"c", "clear"}, button{"q", "close"})), "\n")
}

// --- task manager ---

type tasksApp struct{ list listView }

func (t *tasksApp) title() string { return "Tasks" }
func (t *tasksApp) key() string   { return "tasks" }

// taskRow is one line of the table: what it is, its state, how long, and what it was asked.
type taskRow struct {
	kind, state, detail string
	took                time.Duration
	failed              bool
	tool                *toolItem // the call a tool row is, to open it
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
		row := taskRow{kind: "tool", detail: t.name + " " + toolBrief(t), tool: t}
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
	case "x", "delete":
		if m.phase == busy {
			return false, tea.Batch(m.cancelTurn(), m.toast(toastInfo, "Stopping the running turn"))
		}
		return false, m.toast(toastInfo, "Nothing is running")
	case "enter":
		// To Chat; a tool call opens there, its output shown in full.
		rows := m.taskRows(time.Now())
		if t.list.cursor < len(rows) && rows[t.list.cursor].tool != nil {
			tool := rows[t.list.cursor].tool
			tool.open = true
			tool.touch()
		}
		m.active = 0
		return false, nil
	default:
		t.list.move(msg.String(), len(m.taskRows(time.Now())))
	}
	return false, nil
}

func (t *tasksApp) wheel(m *Model, up bool) tea.Cmd {
	t.list.wheel(up, len(m.taskRows(time.Now())))
	return nil
}

func (t *tasksApp) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	if i, ok := t.list.clicked(m.zones.frame, msg, len(m.taskRows(time.Now()))); ok && t.list.clickRow(i) {
		_, cmd := t.handle(m, keyPress("enter"))
		return cmd
	}
	return nil
}

func (t *tasksApp) view(m *Model) string {
	th, width, height := m.th, m.width, max(m.windowHeight(), 1)
	t.list.zone = "task"
	rows := m.taskRows(time.Now())
	running := 0
	for _, r := range rows {
		if r.state == "running" {
			running++
		}
	}
	head := fmt.Sprintf("%d running · %d tools this session · %s in / %s out", running, m.stats.toolCount(), compact(m.usage.input), compact(m.usage.output))
	lines := []string{" " + th.Faint.Render(m.limitDetail()) + th.Faint.Render(m.effortDetail()), " " + th.Strong.Render(head),
		" " + th.Faint.Render(padRight("TASK", 8)+padRight("STATE", 10)+padRight("TIME", 8)+"WHAT")}
	from, to := t.list.window(len(rows), max(height-4, 1))
	for i := from; i < to; i++ {
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
		line := " " + th.Body.Render(padRight(r.kind, 8)) + state.Render(padRight(r.state, 10)) + th.Faint.Render(padRight(took, 8)) + th.Body.Render(r.detail)
		lines = append(lines, t.list.row(m, m.zones.frame, i, line, width))
	}
	lines = fitLines(lines, width, height-1)
	return strings.Join(append(lines, m.hintBar(width, button{"enter", "open in chat"}, button{"x", "stop the turn"}, button{"q", "close"})), "\n")
}

// effortDetail says how hard the model was last asked to think and why, when the agent decides that
// per call (reasoning "auto"); empty otherwise.
func (m *Model) effortDetail() string {
	if m.effort[0] == "" {
		return ""
	}
	if m.effort[1] == "" {
		return " · thinking: " + m.effort[0]
	}
	return " · thinking: " + m.effort[0] + " (" + m.effort[1] + ")"
}
