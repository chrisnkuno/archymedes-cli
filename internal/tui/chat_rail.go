package tui

import (
	"context"
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/project"
	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// The changes rail: a column beside the transcript, on a terminal wide enough for both, that keeps
// what the work has done in view while it is being done. Every file changed since the last commit
// with its lines added and removed (the one edited last marked), the sub-agents at work and what
// each is doing, the background commands and the last line each printed, and the latest edit's diff. It is read again from git each time an edit lands, by
// Friday or by a sub-agent, not only when the turn ends. alt+d hides it; on a narrow terminal a chip
// in the top bar counts the changed files instead, and opens Changes.

// railMinWidth is the narrowest terminal that shows the rail beside the transcript.
const railMinWidth = 118

type railState struct {
	hidden                   bool
	files                    []project.Change
	added                    int
	remove                   int
	loaded, loading, notRepo bool
	// stale: something changed while a read was under way, or before the first one; read again.
	stale bool
	// changesStale: the Changes window, if open, should read again too.
	changesStale bool
	touched      string       // the file edited last
	latest       *railEdit    // the edit edited last, by anyone
	commands     []*bgCommand // background commands of the session (chat_commands.go)
}

// railEdit is the latest edit: whose, which file, and its diff.
type railEdit struct {
	path, who      string
	diff           string
	added, removed int
	item           *toolItem // the card it is on (a sub-agent's: its delegation card)
}

type railLoadedMsg struct {
	changes []project.Change
	err     error
}

// editLanded is a tool call finishing: an edit gets its diff and marks the rail to be read again.
func (m *Model) editLanded(t *toolItem) {
	attachDiff(t, m.projectRoot())
	if t.diff == "" {
		return
	}
	path, _ := t.args["path"].(string)
	m.rail.latest = &railEdit{path: path, who: "Friday", diff: t.diff, added: t.added, removed: t.removed, item: t}
	m.markEdited(path)
}

// subagentEditLanded is the same for one of a sub-agent's calls.
func (m *Model) subagentEditLanded(card *toolItem, step *subagentStep) {
	if !editTools[step.tool] || step.isError {
		return
	}
	changes, whole := editChanges(step.tool, step.args)
	if changes == nil {
		return
	}
	path, _ := step.args["path"].(string)
	if !whole {
		if written := readWritten(m.projectRoot(), path); written != "" {
			locateChanges(changes, written)
		}
	}
	step.diff, step.added, step.removed = editPatch(changes)
	if step.diff == "" {
		return
	}
	m.rail.latest = &railEdit{path: path, who: subagentRole(card), diff: step.diff, added: step.added, removed: step.removed, item: card}
	m.markEdited(path)
}

func (m *Model) markEdited(path string) {
	m.rail.touched = path
	m.rail.stale, m.rail.changesStale = true, true
}

// railReread reads the changed files again when they are stale and no read is under way, and the
// Changes window with them when an edit landed.
func (m *Model) railReread() tea.Cmd {
	var cmds []tea.Cmd
	if m.rail.changesStale {
		m.rail.changesStale = false
		if c := m.changesWindow(); c != nil && !c.loading {
			cmds = append(cmds, c.reload(m))
		}
	}
	if (m.rail.stale || !m.rail.loaded) && !m.rail.loading {
		m.rail.stale, m.rail.loading = false, true
		root := m.projectRoot()
		cmds = append(cmds, func() tea.Msg {
			changes, err := project.Changes(context.Background(), root)
			return railLoadedMsg{changes, err}
		})
	}
	return tea.Batch(cmds...)
}

func (m *Model) railLoaded(msg railLoadedMsg) tea.Cmd {
	r := &m.rail
	r.loading, r.loaded = false, true
	r.notRepo = msg.err != nil
	r.files, r.added, r.remove = r.files[:0], 0, 0
	for _, f := range msg.changes {
		if !agentState(f.Path) {
			r.files = append(r.files, f)
			r.added, r.remove = r.added+f.Added, r.remove+f.Removed
		}
	}
	if r.stale {
		return m.railReread()
	}
	return nil
}

// workingAgents are the delegation cards whose sub-agent is still at work, oldest first.
func (m *Model) workingAgents() []*toolItem {
	var out []*toolItem
	for _, it := range m.tr.items {
		if t, ok := it.(*toolItem); ok && delegationTools[t.name] && (!t.done || backgroundRunning(t)) {
			out = append(out, t)
		}
	}
	return out
}

// railWidth is the rail's columns, its edge included; 0 when it is not shown.
func (m *Model) railWidth() int {
	if m.rail.hidden || m.width < railMinWidth || m.landingVisible() {
		return 0
	}
	if len(m.rail.files) == 0 && m.rail.latest == nil && len(m.workingAgents()) == 0 && len(m.rail.commands) == 0 {
		return 0
	}
	return min(max(m.width*28/100, 32), 46)
}

// chatWidth is the transcript's width, beside the rail when it is shown.
func (m *Model) chatWidth() int { return max(m.width-2-m.railWidth(), 10) }

// railLines is the rail as height rows, each width columns wide with its edge; nil when hidden.
func (m *Model) railLines(height int) []string {
	width := m.railWidth()
	if width == 0 || height <= 0 {
		return nil
	}
	th := m.th
	inner := width - 2
	edge := lipgloss.NewStyle().Foreground(th.BorderColor).Render("│") + " "
	var rows []string
	add := func(line string) { rows = append(rows, ansi.Truncate(line, inner, "…")) }
	section := func(name, right string) string {
		return spread(th.Strong.Render(name), right, inner)
	}

	// The changed files.
	title := section("Changes", "")
	switch {
	case !m.rail.loaded:
		title = section("Changes", m.spin.View())
	case m.rail.notRepo:
		title = section("Changes", th.Faint.Render("not a git repository"))
	case len(m.rail.files) > 0:
		title = section("Changes", th.Faint.Render(plural(len(m.rail.files), "file")+" ")+diffCounts(th, m.rail.added, m.rail.remove))
	default:
		title = section("Changes", th.Faint.Render("none since the last commit"))
	}
	add(mark(m.zones.frame, "rail:changes", title))
	room := max(height/3, 3)
	for i, f := range m.rail.files {
		if i == room-1 && len(m.rail.files) > room {
			add(th.Faint.Render(fmt.Sprintf("  … %d more · F10 lists them all", len(m.rail.files)-i)))
			break
		}
		add(mark(m.zones.frame, fmt.Sprintf("rail:file:%d", i), railFileRow(th, f, f.Path == m.rail.touched, inner)))
	}

	// The sub-agents at work.
	if agents := m.workingAgents(); len(agents) > 0 {
		add("")
		add(section("Agents", th.Faint.Render("→ inspect")))
		for i, t := range agents {
			if i == 4 {
				add(th.Faint.Render(fmt.Sprintf("  … %d more", len(agents)-i)))
				break
			}
			doing := "starting"
			if st := t.sub.running(); st != nil {
				doing = st.line
			} else if t.sub != nil && len(t.sub.recent) > 0 {
				doing = "thinking · " + plural(t.sub.calls, "call")
			}
			add(mark(m.zones.frame, fmt.Sprintf("rail:agent:%d", i),
				m.spin.View()+" "+th.SoftPill(subagentRole(t), th.Secondary)+" "+th.Faint.Render(doing)))
		}
	}

	// The background commands: running ones with the last line they printed.
	if commands := m.railCommands(); len(commands) > 0 {
		add("")
		add(section("Commands", th.Faint.Render(fmt.Sprintf("%d running", m.runningCommands()))))
		for _, c := range commands {
			glyph, state := m.spin.View(), th.Faint
			switch {
			case c.status == "failed" || (strings.HasPrefix(c.status, "exited") && c.status != "exited 0"):
				glyph, state = th.Bad.Render("✗"), th.Bad
			case !c.running():
				glyph = th.OK.Render("✓")
			}
			add(glyph + " " + th.Key.Render(c.id) + " " + th.Body.Render(c.command) + state.Render(" · "+c.status))
			if c.last != "" && c.running() {
				add(th.Faint.Render("  ⎿ " + c.last))
			}
		}
	}

	// The latest edit's diff, to the bottom.
	if e := m.rail.latest; e != nil && len(rows)+3 < height {
		add("")
		head := th.Strong.Render("Latest edit") + th.Faint.Render(" · "+e.who)
		add(mark(m.zones.frame, "rail:edit", spread(head, diffCounts(th, e.added, e.removed), inner)))
		add(th.Body.Render(truncateMiddle(e.path, inner)))
		diff := railDiffRows(th, e.diff, inner)
		if left := height - len(rows); len(diff) > left {
			diff = append(diff[:max(left-1, 0)], th.Faint.Render(fmt.Sprintf("… %s more · → inspect", plural(len(diff)-left+1, "line"))))
		}
		for _, line := range diff {
			add(line)
		}
	}
	for len(rows) < height {
		rows = append(rows, "")
	}
	out := make([]string, height)
	for i := range out {
		out[i] = edge + padRight(rows[i], inner)
	}
	return out
}

// railFileRow is one changed file: its status, its path (the end of it kept), its counts; the file
// edited last is marked and bright.
func railFileRow(th theme.Theme, f project.Change, touched bool, width int) string {
	glyph := map[string]string{"added": "A", "deleted": "D", "renamed": "R", "untracked": "?", "conflict": "!"}[f.Status]
	if glyph == "" {
		glyph = "M"
	}
	counts := "bin"
	if !f.Binary {
		counts = diffCounts(th, f.Added, f.Removed)
	}
	lead := th.Faint.Render(" " + glyph + " ")
	name := th.Body
	if touched {
		lead, name = th.Highlight.Render("●"+glyph+" "), th.Highlight
	}
	room := max(width-3-ansi.StringWidth(counts)-1, 4)
	return lead + name.Render(padRight(truncateMiddle(f.Path, room), room)) + " " + counts
}

// railDiffRows draws a diff compactly for the rail: no number columns, each hunk opened by its
// line, added and removed lines on a tint of their colour.
func railDiffRows(th theme.Theme, text string, width int) []string {
	var rows []string
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		line = strings.ReplaceAll(line, "\t", "  ")
		switch {
		case strings.HasPrefix(line, "@@"):
			_, at := hunkStart(line)
			label := "⋯ edit"
			if at > 0 {
				label = fmt.Sprintf("⋯ line %d", at)
			}
			rows = append(rows, lipgloss.NewStyle().Foreground(th.Secondary).Render(label))
		case strings.HasPrefix(line, "+"):
			rows = append(rows, lipgloss.NewStyle().Foreground(th.Success).Background(th.Tint(th.Success, 0.18)).Width(width).Render(ansi.Truncate(line, width, "…")))
		case strings.HasPrefix(line, "-"):
			rows = append(rows, lipgloss.NewStyle().Foreground(th.Error).Background(th.Tint(th.Error, 0.18)).Width(width).Render(ansi.Truncate(line, width, "…")))
		default:
			rows = append(rows, th.Faint.Render(ansi.Truncate(line, width, "…")))
		}
	}
	return rows
}

// railClick is a click on the rail: the title opens Changes, a file opens it on that file, the
// latest edit and an agent open the inspector on them.
func (m *Model) railClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	if m.railWidth() == 0 {
		return nil, false
	}
	frame := m.zones.frame
	if frame.Get("rail:changes").InBounds(msg) {
		return m.openChanges(), true
	}
	for i, f := range m.rail.files {
		if frame.Get(fmt.Sprintf("rail:file:%d", i)).InBounds(msg) {
			return m.openChangesOn(f.Path), true
		}
	}
	if frame.Get("rail:edit").InBounds(msg) && m.rail.latest != nil {
		return m.openInspector(m.rail.latest.item), true
	}
	for i, t := range m.workingAgents() {
		if frame.Get(fmt.Sprintf("rail:agent:%d", i)).InBounds(msg) {
			return m.openInspector(t), true
		}
	}
	return nil, false
}

// changesChip is the top bar's count of changed files when the rail is not beside the transcript;
// a click opens Changes.
func (m *Model) changesChip() string {
	if len(m.rail.files) == 0 || m.railWidth() > 0 || m.landingVisible() {
		return ""
	}
	th := m.th
	return mark(m.zones.frame, "changes-chip", th.Faint.Render("± "+plural(len(m.rail.files), "file")+" ")+diffCounts(th, m.rail.added, m.rail.remove)) + " "
}

// toggleRail is alt+d: the rail hides, or comes back.
func (m *Model) toggleRail() tea.Cmd {
	m.rail.hidden = !m.rail.hidden
	switch {
	case m.rail.hidden:
		return m.toast(toastInfo, "Changes rail hidden; alt+d brings it back")
	case m.width < railMinWidth:
		return m.toast(toastInfo, fmt.Sprintf("The changes rail needs %d columns; the top bar counts the changes meanwhile", railMinWidth))
	}
	return m.toast(toastInfo, "Changes rail shown")
}
