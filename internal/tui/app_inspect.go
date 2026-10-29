package tui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/gallery"
	"github.com/chrisnkuno/friday-cli/internal/render"
)

// The Inspector (→): everything the session's helpers and edits did, in full. On the left, every
// sub-agent (those at work first) and every edit, newest first; on the right, the one selected. A
// sub-agent shows its task, its whole timeline (each call, how long it took, whether it failed),
// the diff of every edit it made, and its report once done; an edit shows its whole diff. → steps
// into the timeline, where ↑/↓ choose a call and enter opens it in place; ← steps back out, and
// from the list back to Chat. A sub-agent at work is followed as it goes, newest call in view.
//
// It keeps nothing of its own: what it shows is read from the transcript's cards each frame, so it
// is as live as they are.

type inspectApp struct {
	list    listView
	pick    *toolItem // the card to select on the next draw (opened on it)
	shown   *toolItem // the card selected when last drawn
	onSteps bool      // the arrows are on the timeline (→), not the list (←)
	step    int       // the chosen call in the timeline
	open    map[*subagentStep]bool
	scroll  int   // the detail's first row
	follow  bool  // keep the newest call in view while the sub-agent works
	steps   []int // the detail row each call starts on, as last drawn
	rows    int   // the detail's rows, as last drawn
	height  int   // the detail's height, as last drawn
}

func (a *inspectApp) title() string { return "Inspector" }
func (a *inspectApp) key() string   { return "inspect" }

// openInspector opens the Inspector on a card; nil picks the sub-agent at work, else the latest edit.
func (m *Model) openInspector(t *toolItem) tea.Cmd {
	if t == nil {
		if agents := m.workingAgents(); len(agents) > 0 {
			t = agents[len(agents)-1]
		} else if m.rail.latest != nil {
			t = m.rail.latest.item
		} else if subjects := m.inspectSubjects(nil); len(subjects) > 0 {
			t = subjects[0]
		}
	}
	if t == nil {
		return m.toast(toastInfo, "Nothing to inspect yet; sub-agents and edits show up here as they happen")
	}
	a, ok := windowOf[*inspectApp](m)
	if !ok {
		a = &inspectApp{open: map[*subagentStep]bool{}}
	}
	a.pick, a.onSteps, a.scroll, a.follow = t, false, 0, true
	m.openWindow(a)
	return nil
}

// inspectable is a card the Inspector lists: a sub-agent, or a call that changed a file.
func inspectable(t *toolItem) bool { return delegationTools[t.name] || t.diff != "" }

// inspectSubjects are the cards the Inspector lists: sub-agents at work first, then the rest
// newest first; extra is listed too when it is not one of them (the card it was opened on).
func (m *Model) inspectSubjects(extra *toolItem) []*toolItem {
	var working, rest []*toolItem
	for i := len(m.tr.items) - 1; i >= 0; i-- {
		t, ok := m.tr.items[i].(*toolItem)
		if !ok || (!inspectable(t) && t != extra) {
			continue
		}
		if delegationTools[t.name] && (!t.done || backgroundRunning(t)) {
			working = append(working, t)
		} else {
			rest = append(rest, t)
		}
	}
	return append(working, rest...)
}

func (a *inspectApp) subjects(m *Model) []*toolItem {
	extra := a.pick
	if extra == nil {
		extra = a.shown
	}
	subjects := m.inspectSubjects(extra)
	if a.pick != nil {
		for i, t := range subjects {
			if t == a.pick {
				a.list.cursor = i
			}
		}
		a.pick = nil
	}
	a.list.cursor = min(a.list.cursor, max(len(subjects)-1, 0))
	return subjects
}

func (a *inspectApp) selected(m *Model) *toolItem {
	subjects := a.subjects(m)
	if a.list.cursor < len(subjects) {
		return subjects[a.list.cursor]
	}
	return nil
}

// choose moves the list to row i, and the detail to its top.
func (a *inspectApp) choose(i int) {
	if i != a.list.cursor {
		a.list.cursor, a.scroll, a.step, a.onSteps, a.follow = i, 0, 0, false, true
	}
}

func (a *inspectApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	t := a.selected(m)
	var steps []*subagentStep
	if t != nil && t.sub != nil {
		steps = t.sub.steps
	}
	page := max(a.height-2, 1)
	switch msg.String() {
	case "esc", "q":
		return true, nil
	case "left", "h":
		if !a.onSteps {
			m.active = 0 // back to Chat, where → came from
			return false, nil
		}
		a.onSteps = false
	case "right", "l":
		if len(steps) > 0 {
			a.onSteps, a.follow = true, false
			a.step = min(max(a.step, 0), len(steps)-1)
			if a.step == 0 {
				a.step = len(steps) - 1 // the newest call first: it is what is happening
			}
			a.reveal()
		}
	case "up", "k":
		if a.onSteps {
			a.step = max(a.step-1, 0)
			a.reveal()
			return false, nil
		}
		a.choose(max(a.list.cursor-1, 0))
	case "down", "j":
		if a.onSteps {
			a.step = min(a.step+1, len(steps)-1)
			a.reveal()
			return false, nil
		}
		a.choose(min(a.list.cursor+1, max(len(a.subjects(m))-1, 0)))
	case "enter":
		if a.onSteps && a.step < len(steps) {
			st := steps[a.step]
			a.open[st] = !a.open[st]
			return false, nil
		}
		if len(steps) > 0 {
			return a.handle(m, keyPress("right"))
		}
		return false, a.read(m, t, nil)
	case "space":
		if a.onSteps && a.step < len(steps) {
			return false, a.read(m, t, steps[a.step])
		}
		return false, a.read(m, t, nil)
	case "t":
		// To the card in Chat, selected there.
		if t != nil {
			m.active = 0
			m.selectItem(t)
		}
	case "pgdown", "shift+down":
		a.scroll, a.follow = a.scroll+page, false
	case "pgup", "shift+up":
		a.scroll, a.follow = max(a.scroll-page, 0), false
	case "home", "g":
		a.scroll, a.follow = 0, false
	case "end", "G":
		a.follow = true
	}
	return false, nil
}

// reveal scrolls the detail so the chosen call is in view.
func (a *inspectApp) reveal() {
	if a.step >= len(a.steps) {
		return
	}
	row := a.steps[a.step]
	switch {
	case row < a.scroll:
		a.scroll = max(row-1, 0)
	case row >= a.scroll+a.height-1:
		a.scroll = row - a.height + 3
	}
}

// read opens a card, or one of its sub-agent's calls, in a reader: all of it, searchable.
func (a *inspectApp) read(m *Model, t *toolItem, st *subagentStep) tea.Cmd {
	switch {
	case st != nil:
		text := st.line + "\n\n" + st.result
		if st.diff != "" {
			m.openWindow(newPager(m, st.line, diffRows(m.th, st.diff, max(m.width-12, 20))))
			return nil
		}
		m.openWindow(newPager(m, st.line, strings.Split(strings.TrimRight(text, "\n"), "\n")))
	case t != nil && t.diff != "":
		m.openWindow(newPager(m, "diff "+toolBrief(t), diffRows(m.th, t.diff, max(m.width-12, 20))))
	case t != nil:
		return m.readItem(t)
	}
	return nil
}

func (a *inspectApp) wheelAt(m *Model, up bool, x, _ int) tea.Cmd {
	if x < inspectListWidth(m.width) {
		subjects := a.subjects(m)
		a.list.wheel(up, len(subjects))
		a.choose(a.list.cursor)
		return nil
	}
	if up {
		a.scroll, a.follow = max(a.scroll-wheelStep, 0), false
	} else {
		a.scroll += wheelStep
	}
	return nil
}

func (a *inspectApp) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	subjects := a.subjects(m)
	if i, ok := a.list.clicked(m.zones.frame, msg, len(subjects)); ok {
		if i == a.list.cursor {
			_, cmd := a.handle(m, keyPress("enter")) // a second click opens it
			return cmd
		}
		a.choose(i)
		return nil
	}
	for i := range a.steps {
		if m.zones.frame.Get(fmt.Sprintf("insp:step:%d", i)).InBounds(msg) {
			again := a.onSteps && a.step == i
			a.onSteps, a.step, a.follow = true, i, false
			if again {
				_, cmd := a.handle(m, keyPress("enter"))
				return cmd
			}
			return nil
		}
	}
	return nil
}

// inspectListWidth is the list's width beside the detail.
func inspectListWidth(width int) int { return max(min(width/3, 40), min(width, 20)) }

func (a *inspectApp) view(m *Model) string {
	th := m.th
	width, height := m.width, max(m.windowHeight(), 1)
	subjects := a.subjects(m)
	working := len(m.workingAgents())
	right := th.Faint.Render(plural(len(subjects), "item") + " ")
	if working > 0 {
		right = m.spin.View() + th.Highlight.Render(fmt.Sprintf(" %d at work ", working)) + right
	}
	rows := []string{spread(" "+th.Title.Render("Inspector")+th.Faint.Render("  sub-agents and edits, in full"), right, width)}
	body := height - 2
	if len(subjects) == 0 {
		rows = append(rows, m.emptyState(gallery.OfTheme("math", 3), []string{
			th.Body.Render("Nothing to inspect yet."),
			th.Faint.Render("Sub-agents and edits show up here as they happen; → opens this from Chat."),
		}, width, body)...)
		return strings.Join(append(rows, m.hintBar(width, button{"←", "chat"}, button{"q", "close"})), "\n")
	}
	listW := inspectListWidth(width)
	detailW := max(width-listW-3, 10)
	a.list.zone = "insp"
	from, to := a.list.window(len(subjects), body)
	var left []string
	for i := from; i < to; i++ {
		left = append(left, a.list.row(m, m.zones.frame, i, inspectRow(m, subjects[i], listW), listW))
	}
	t := subjects[a.list.cursor]
	a.shown = t
	detail := a.detail(m, t, detailW)
	a.rows, a.height = len(detail), body
	if a.follow {
		a.scroll = max(len(detail)-body, 0)
	}
	a.scroll = min(a.scroll, max(len(detail)-body, 0))
	edge := th.BorderColor
	if a.onSteps {
		edge = th.BorderFocus
	}
	rule := lipgloss.NewStyle().Foreground(edge).Render("│")
	for i := 0; i < body; i++ {
		rows = append(rows, padRight(at(left, i), listW)+" "+rule+" "+ansi.Truncate(at(detail, a.scroll+i), detailW, ""))
	}
	buttons := []button{{"→", "timeline"}, {"space", "read"}, {"t", "show in chat"}, {"←", "chat"}, {"q", "close"}}
	if a.onSteps {
		buttons = []button{{"enter", "open call"}, {"space", "read"}, {"←", "list"}, {"pgdn", "scroll"}, {"q", "close"}}
	} else if t.sub == nil || len(t.sub.steps) == 0 {
		buttons = []button{{"space", "read"}, {"t", "show in chat"}, {"←", "chat"}, {"q", "close"}}
	}
	return strings.Join(append(rows, m.hintBar(width, buttons...)), "\n")
}

// inspectRow is one card in the list: its state, what it is, and how much it did.
func inspectRow(m *Model, t *toolItem, width int) string {
	th := m.th
	glyph := th.OK.Render("✓")
	switch {
	case !t.done || backgroundRunning(t):
		glyph = m.spin.View()
	case t.isError:
		glyph = th.Bad.Render("✗")
	}
	var label, tail string
	if delegationTools[t.name] {
		label = "agent · " + subagentRole(t)
		if t.sub != nil {
			tail = th.Faint.Render(plural(t.sub.calls, "call"))
		}
	} else {
		label = toolLabel(t.name) + " · " + toolBrief(t)
		if t.diff != "" {
			tail = diffCounts(th, t.added, t.removed)
		}
	}
	room := max(width-3-ansi.StringWidth(tail)-1, 4)
	return glyph + " " + th.Body.Render(padRight(truncateMiddle(label, room), room)) + " " + tail
}

// detail is the selected card in full, as rows width wide; it records where each call starts.
func (a *inspectApp) detail(m *Model, t *toolItem, width int) []string {
	th := m.th
	a.steps = a.steps[:0]
	var rows []string
	add := func(lines ...string) {
		for _, l := range lines {
			rows = append(rows, ansi.Truncate(l, width, "…"))
		}
	}
	wrap := func(style lipgloss.Style, text string) {
		for _, l := range strings.Split(ansi.Wrap(strings.TrimSpace(text), width, ""), "\n") {
			add(style.Render(l))
		}
	}
	heading := func(name string) {
		add("", th.Strong.Render(name)+" "+th.Faint.Render(strings.Repeat("─", max(width-ansi.StringWidth(name)-1, 0))))
	}

	if !delegationTools[t.name] {
		add(th.SoftPill(toolLabel(t.name), th.Secondary) + " " + th.Body.Render(render.DescribeToolCall(t.name, t.args)))
		state := "running " + elapsed(time.Since(t.started))
		if t.done {
			state = "took " + elapsed(t.ended.Sub(t.started))
		}
		add(th.Faint.Render(state))
		if t.diff != "" {
			heading("Diff")
			add(diffRows(th, t.diff, width)...)
		} else if t.done {
			heading("Output")
			add(render.Excerpt(th, t.result, width, 0)...)
		}
		return rows
	}

	// A sub-agent: who, how far, what it was asked.
	state := "at work · " + elapsed(time.Since(t.started))
	switch {
	case backgroundRunning(t):
		state = "in the background · " + elapsed(time.Since(t.started))
	case t.done && t.isError:
		state = "failed after " + elapsed(t.ended.Sub(t.started))
	case t.done:
		state = "done in " + elapsed(t.ended.Sub(t.started))
	}
	add(th.SoftPill("agent · "+subagentRole(t), th.Secondary) + " " + th.Faint.Render(state+" · "+subagentSummary(t)))
	for _, k := range []string{"task", "prompt", "description"} {
		if task, ok := t.args[k].(string); ok && strings.TrimSpace(task) != "" {
			heading("Task")
			wrap(th.Body, task)
			break
		}
	}

	// Every call, in order; the chosen one marked, an opened one with its output or diff below.
	heading("Timeline")
	if t.sub == nil || len(t.sub.steps) == 0 {
		add(th.Faint.Render("no calls yet"))
	} else {
		if t.sub.dropped > 0 {
			add(th.Faint.Render(fmt.Sprintf("… %s before these are not kept", plural(t.sub.dropped, "call"))))
		}
		for i, st := range t.sub.steps {
			a.steps = append(a.steps, len(rows))
			add(mark(m.zones.frame, fmt.Sprintf("insp:step:%d", i), a.stepRow(m, st, i, width)))
			if a.open[st] || st.diff != "" {
				add(stepBody(m, st, width, a.open[st])...)
			}
		}
	}

	// What it reported.
	if t.done && !backgroundRunning(t) && strings.TrimSpace(t.result) != "" {
		heading("Report")
		add(strings.Split(m.md.Render(strings.TrimSpace(t.result), width), "\n")...)
	}
	return rows
}

// stepRow is one call in the timeline: its state, the call in words, its counts, its time.
func (a *inspectApp) stepRow(m *Model, st *subagentStep, i, width int) string {
	th := m.th
	glyph := th.OK.Render("✓")
	took := elapsed(st.ended.Sub(st.started))
	switch {
	case !st.done:
		glyph, took = m.spin.View(), "running "+elapsed(time.Since(st.started))
	case st.isError:
		glyph = th.Bad.Render("✗")
	}
	tail := th.Faint.Render(took)
	if st.diff != "" {
		tail = diffCounts(th, st.added, st.removed) + " " + tail
	}
	room := max(width-4-ansi.StringWidth(tail), 4)
	line := " " + glyph + " " + th.Body.Render(padRight(ansi.Truncate(st.line, room, "…"), room)) + " " + tail
	if a.onSteps && i == a.step {
		return selectedBar(m, padRight(ansi.Strip(line), width))
	}
	return line
}

// stepBody is under an opened call: its diff, else its output; a closed edit shows the start of
// its diff, so what each edit did is visible down the whole timeline.
func stepBody(m *Model, st *subagentStep, width int, opened bool) []string {
	th := m.th
	rule := lipgloss.NewStyle().Foreground(th.Tint(th.Secondary, 0.55)).Render("   │ ")
	var body []string
	if st.diff != "" {
		body = diffRows(th, st.diff, max(width-5, 10))
	} else {
		body = render.Excerpt(th, st.result, max(width-5, 10), 0)
	}
	if !opened && len(body) > 6 {
		body = append(body[:6], th.Faint.Render(fmt.Sprintf("… %s more · enter opens it", plural(len(body)-6, "line"))))
	}
	out := make([]string, len(body))
	for i, l := range body {
		out[i] = rule + l
	}
	return out
}
