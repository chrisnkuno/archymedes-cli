package tui

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/project"
)

// The growth panel (alt+v, /growth): the project as a tree that grows while the work is done. Its
// sections are the project's own folders, the big ones opened into sub-branches; each fills with
// the code it holds, its part written this session drawn in a brighter shade; the agent's plan
// grows on it as buds, each on the section it is about, open, in progress or done; and code taken
// out shows as pruning. It is measured again when an edit lands, reading only the files that
// changed since the last measure.

// growthMinWidth is the narrowest terminal that shows the panel beside the conversation.
const growthMinWidth = 96

type growthState struct {
	shown               bool
	wide                bool // extended: half the screen, for a big tree (/growth wide, a click on its title)
	measuring, measured bool
	stale               bool
	root                string
	lines               map[string]int // code lines per file, now
	base                map[string]int // code lines per file at the first measure of the session
	cache               map[string]fileCount
	edits               map[string][2]int // lines added and removed per file this session
	plan                []growthBud
	placed              map[int]string // a plan item's id → the file it was worked on in
	truncated           bool
	measuredAt          time.Time
	// version moves with every change the panel draws; drawn is the last drawing, by drawnKey.
	version  int
	drawn    []string
	drawnKey string
}

// fileCount is one file's lines as last counted, with what it was counted at.
type fileCount struct {
	size  int64
	mtime int64
	lines int
}

// growthBud is one item of the agent's plan.
type growthBud struct {
	id     int
	status string // pending, in_progress, done
	text   string
}

type growthMeasuredMsg struct {
	root      string
	lines     map[string]int
	cache     map[string]fileCount
	truncated bool
}

// maxCountedBytes: a file larger than this is generated or data, not code someone writes.
const maxCountedBytes = 2 << 20

// isCode is whether a file counts toward growth: source in a language Friday knows, not prose,
// data or configuration.
func isCode(rel string) bool {
	switch project.Language(rel) {
	case "", "markdown", "json", "yaml", "toml":
		return false
	}
	return !agentState(rel)
}

// measureGrowth counts the project's code lines, file by file, reusing a count whose file has the
// same size and modification time. It runs off the update loop.
func measureGrowth(root string, cache map[string]fileCount) tea.Cmd {
	return func() tea.Msg {
		files, truncated, err := project.Files(context.Background(), root)
		if err != nil {
			return growthMeasuredMsg{root: root, lines: map[string]int{}, cache: cache}
		}
		lines := make(map[string]int, len(files))
		next := make(map[string]fileCount, len(files))
		for _, rel := range files {
			if !isCode(rel) {
				continue
			}
			info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
			if err != nil || info.IsDir() || info.Size() > maxCountedBytes {
				continue
			}
			c, ok := cache[rel]
			if !ok || c.size != info.Size() || c.mtime != info.ModTime().UnixNano() {
				c = fileCount{size: info.Size(), mtime: info.ModTime().UnixNano(), lines: countLines(filepath.Join(root, filepath.FromSlash(rel)))}
			}
			next[rel] = c
			if c.lines > 0 {
				lines[rel] = c.lines
			}
		}
		return growthMeasuredMsg{root: root, lines: lines, cache: next, truncated: truncated}
	}
}

// countLines is a file's non-blank lines; 0 for a binary file.
func countLines(path string) int {
	data, err := os.ReadFile(path)
	if err != nil || bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
		return 0
	}
	n := 0
	for len(data) > 0 {
		line := data
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			line, data = data[:i], data[i+1:]
		} else {
			data = nil
		}
		if len(bytes.TrimSpace(line)) > 0 {
			n++
		}
	}
	return n
}

// growthReread measures again when the panel is shown and something changed.
func (m *Model) growthReread() tea.Cmd {
	g := &m.growth
	if !g.shown || g.measuring || (g.measured && !g.stale && g.root == m.projectRoot()) {
		return nil
	}
	g.stale, g.measuring = false, true
	return measureGrowth(m.projectRoot(), g.cache)
}

func (m *Model) growthMeasured(msg growthMeasuredMsg) tea.Cmd {
	g := &m.growth
	g.measuring = false
	if msg.root != m.projectRoot() {
		g.stale = true
		return m.growthReread()
	}
	if g.base == nil || g.root != msg.root {
		g.base = msg.lines
	}
	g.root, g.lines, g.cache, g.truncated, g.measured, g.measuredAt = msg.root, msg.lines, msg.cache, msg.truncated, true, time.Now()
	g.version++
	return m.growthReread() // an edit that landed meanwhile
}

// growthEdit is an edit landing, by Friday or a helper: its lines count this session, the plan
// item in progress is placed on its file, and the tree is measured again.
func (m *Model) growthEdit(path string, added, removed int) {
	g := &m.growth
	if path == "" {
		return
	}
	rel := m.relativePath(path)
	if g.edits == nil {
		g.edits = map[string][2]int{}
	}
	e := g.edits[rel]
	g.edits[rel] = [2]int{e[0] + added, e[1] + removed}
	g.version++
	for _, b := range g.plan {
		if b.status == "in_progress" {
			if g.placed == nil {
				g.placed = map[int]string{}
			}
			if _, ok := g.placed[b.id]; !ok {
				g.placed[b.id] = rel
			}
		}
	}
	g.stale = true
}

// relativePath is a path the engine sent, relative to the project root.
func (m *Model) relativePath(path string) string {
	path = filepath.ToSlash(path)
	if root := filepath.ToSlash(m.projectRoot()); root != "" && strings.HasPrefix(path, root+"/") {
		path = strings.TrimPrefix(path, root+"/")
	}
	return strings.TrimPrefix(path, "./")
}

// planLine is one line of todo_write's and todo_read's result: "[x] 3. write the tests".
var planLine = regexp.MustCompile(`^\[([ x~])\] (\d+)\. (.+)$`)

// growthPlan reads the agent's plan from a todo call's result.
func (m *Model) growthPlan(tool, result string, isError bool) {
	if isError || (tool != "todo_write" && tool != "todo_read") {
		return
	}
	var plan []growthBud
	for _, line := range strings.Split(result, "\n") {
		mm := planLine.FindStringSubmatch(strings.TrimSpace(line))
		if mm == nil {
			continue
		}
		id, _ := strconv.Atoi(mm[2])
		status := map[string]string{" ": "pending", "~": "in_progress", "x": "done"}[mm[1]]
		plan = append(plan, growthBud{id: id, status: status, text: mm[3]})
	}
	if plan != nil || strings.HasPrefix(result, "No plan yet") {
		m.growth.plan = plan
		m.growth.version++
	}
}

// growthWidth is the panel's columns, its edge included; 0 when it is not shown.
func (m *Model) growthWidth() int {
	if !m.growth.shown || m.width < growthMinWidth || m.landingVisible() {
		return 0
	}
	narrow := min(max(m.width*27/100, 30), 44)
	if m.growth.wide {
		return max(narrow, m.width/2) // the rail steps aside when what is left is too narrow for it
	}
	return narrow
}

func (m *Model) toggleGrowth() tea.Cmd {
	m.growth.shown = !m.growth.shown
	switch {
	case !m.growth.shown:
		return m.toast(toastInfo, "Growth panel hidden; alt+v brings it back")
	case m.width < growthMinWidth:
		return tea.Batch(m.toast(toastInfo, "The growth panel needs "+strconv.Itoa(growthMinWidth)+" columns"), m.growthReread())
	}
	return m.growthReread()
}

// growthCommand is /growth: alone it shows or hides the panel; wide extends it to half the screen,
// narrow brings it back beside the conversation, off hides it.
func (m *Model) growthCommand(arg string) tea.Cmd {
	switch strings.ToLower(strings.TrimSpace(arg)) {
	case "":
		return m.toggleGrowth()
	case "off", "hide":
		if !m.growth.shown {
			return nil
		}
		return m.toggleGrowth()
	case "wide", "extend", "extended":
		return tea.Batch(m.setGrowthWide(true), m.toast(toastInfo, "Growth panel extended; click its title or /growth narrow to narrow it"))
	case "narrow":
		return m.setGrowthWide(false)
	}
	return m.toast(toastWarn, "/growth takes wide, narrow or off")
}

// setGrowthWide shows the panel at one of its two widths.
func (m *Model) setGrowthWide(wide bool) tea.Cmd {
	m.growth.wide = wide
	if !m.growth.shown {
		return m.toggleGrowth()
	}
	return nil
}

// growthClick is a click on the panel: its title switches between the two widths. It says nothing:
// the panel moving is the answer, and a toast would float over the title the next click aims at.
func (m *Model) growthClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	if m.growthWidth() == 0 || !m.zones.frame.Get("growth:title").InBounds(msg) {
		return nil, false
	}
	return m.setGrowthWide(!m.growth.wide), true
}

// growthLines is the panel as height rows, each growthWidth columns wide with its edge; nil when
// it is not shown.
func (m *Model) growthLines(height int) []string {
	width := m.growthWidth()
	if width == 0 || height <= 0 {
		return nil
	}
	th, g := m.th, &m.growth
	// Drawn again only when something it shows changed: the spinner redraws the screen ten times a
	// second, and a tree of a big project is not rebuilt for that.
	key := fmt.Sprintf("%d/%d/%d/%s", g.version, width, height, th.Name)
	if g.measured && key == g.drawnKey {
		return g.drawn
	}
	inner := width - 2
	edge := lipgloss.NewStyle().Foreground(th.BorderColor).Render("│") + " "
	var rows []string
	add := func(line string) { rows = append(rows, ansi.Truncate(line, inner, "…")) }

	tree := buildGrowthTree(g.lines, g.base, g.edits)
	right := th.Faint.Render(compactCount(tree.lines) + " lines")
	if !g.measured {
		right = m.spin.View()
	}
	add(spread(mark(m.zones.frame, "growth:title", th.Strong.Render("Growth")), right, inner))
	session := th.Faint.Render("this session ")
	switch {
	case tree.added == 0 && tree.removed == 0:
		session += th.Faint.Render("nothing written yet")
	case tree.removed > tree.added:
		session += th.OK.Render("+"+compactCount(tree.added)) + " " + th.Bad.Render("−"+compactCount(tree.removed)) + th.Warn.Render(" · pruned")
	default:
		session += th.OK.Render("+"+compactCount(tree.added)) + " " + th.Bad.Render("−"+compactCount(tree.removed))
	}
	add(session)
	if len(g.plan) > 0 {
		done := 0
		for _, b := range g.plan {
			if b.status == "done" {
				done++
			}
		}
		const planBar = 10
		filled := done * planBar / len(g.plan)
		add(th.Faint.Render("plan ") + th.OK.Render(strings.Repeat("█", filled)) + th.Faint.Render(strings.Repeat("░", planBar-filled)) + th.Faint.Render(fmt.Sprintf(" %d/%d steps", done, len(g.plan))))
	}
	add("")
	if g.measured && tree.lines == 0 && len(g.plan) == 0 && tree.added == 0 {
		add(th.Faint.Render("No code yet. Sections appear as"))
		add(th.Faint.Render("files are written, and the plan's"))
		add(th.Faint.Render("steps grow on them."))
	} else {
		budget := height - len(rows)
		tree.openBranches(max(budget-len(g.plan)-2, 4))
		tree.placeBuds(g.plan, g.placed)
		for _, line := range growthRows(th, tree, inner, budget) {
			add(line)
		}
	}
	if g.truncated && len(rows) < height {
		add(th.Faint.Render(fmt.Sprintf("first %d files counted", project.MaxFiles)))
	}
	out := make([]string, height)
	for i := range out {
		line := ""
		if i < len(rows) {
			line = rows[i]
		}
		out[i] = edge + padRight(line, inner)
	}
	if g.measured {
		g.drawn, g.drawnKey = out, key
	}
	return out
}

// joinColumns sets side panels next to each other, row by row; nil when there are none.
func joinColumns(left, right []string) []string {
	switch {
	case left == nil:
		return right
	case right == nil:
		return left
	}
	out := make([]string, max(len(left), len(right)))
	lw, rw := ansi.StringWidth(left[0]), ansi.StringWidth(right[0])
	for i := range out {
		l, r := strings.Repeat(" ", lw), strings.Repeat(" ", rw)
		if i < len(left) {
			l = left[i]
		}
		if i < len(right) {
			r = right[i]
		}
		out[i] = l + r
	}
	return out
}
