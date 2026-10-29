package tui

import (
	"context"
	"errors"
	"fmt"
	"path"
	"slices"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/gallery"
	"github.com/chrisnkuno/friday-cli/internal/project"
	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// The Changes app (F10): what is different from the last commit, file by file — the list on the
// left with each file's lines added and removed, the selected file's diff on the right with old
// and new line numbers. b turns to the Branches view (app_changes_branches.go): the branches, worktrees and
// stash. It reads git directly and never writes; it refreshes itself when a turn ends, since that
// is when the agent's edits (and commits) land.

type changesLoadedMsg struct {
	changes []project.Change
	err     error
}

type diffLoadedMsg struct {
	path      string
	text      string
	truncated bool
	err       error
}

type fileDiff struct {
	loading   bool
	text      string
	truncated bool
	err       string
	rows      []string // drawn, for rowsWidth
	rowsWidth int
	hunks     []int     // row index of each hunk header
	refs      []lineRef // what each row points at, for comments
}

type changesApp struct {
	loaded  bool
	loading bool
	err     string
	notRepo bool
	files   []project.Change
	cursor  int
	list    listView // the file list's place: cursor is c.cursor, kept in step
	scroll  int      // the diff's first row
	line    int      // the diff row chosen for a comment; -1 is none
	onDiff  bool     // the arrows are on the diff (→), not the file list (←)
	diffs   map[string]*fileDiff

	showBranches bool
	br           *branchesView
	pick         string // a file to select once the list is read (a click on it in the rail)
}

func (c *changesApp) title() string { return "Changes" }
func (c *changesApp) key() string   { return "changes" }

func (m *Model) openChanges() tea.Cmd {
	for _, w := range m.windows {
		if c, ok := w.(*changesApp); ok {
			m.openWindow(c)
			return c.reload(m) // focusing it again is asking what changed now
		}
	}
	c := &changesApp{line: -1, diffs: map[string]*fileDiff{}, br: &branchesView{details: map[string]*branchDetail{}}}
	m.openWindow(c)
	return c.reload(m)
}

// openChangesOn opens Changes with path selected.
func (m *Model) openChangesOn(path string) tea.Cmd {
	cmd := m.openChanges()
	if c := m.changesWindow(); c != nil {
		c.pick, c.showBranches, c.onDiff = path, false, false
	}
	return cmd
}

func (m *Model) changesWindow() *changesApp {
	for _, w := range m.windows {
		if c, ok := w.(*changesApp); ok {
			return c
		}
	}
	return nil
}

// reload reads the file list and the branches in the background; the diffs and the branches'
// details are read again as they are shown.
func (c *changesApp) reload(m *Model) tea.Cmd {
	c.loading = true
	root := m.projectRoot()
	return tea.Batch(func() tea.Msg {
		changes, err := project.Changes(context.Background(), root)
		return changesLoadedMsg{changes, err}
	}, c.br.reload(m))
}

func (m *Model) changesLoaded(msg changesLoadedMsg) tea.Cmd {
	c := m.changesWindow()
	if c == nil {
		return nil
	}
	selected := c.pick
	if f, ok := c.selected(); ok && selected == "" {
		selected = f.Path
	}
	c.pick = ""
	c.loaded, c.loading, c.err, c.notRepo = true, false, "", false
	c.diffs = map[string]*fileDiff{}
	switch {
	case errors.Is(msg.err, project.ErrNotRepository):
		c.notRepo = true
	case msg.err != nil:
		c.err = msg.err.Error()
	}
	c.files = c.files[:0]
	for _, f := range msg.changes {
		if !agentState(f.Path) {
			c.files = append(c.files, f)
		}
	}
	// Stay on the file that was selected, if it is still changed.
	c.cursor = min(c.cursor, max(len(c.files)-1, 0))
	for i, f := range c.files {
		if f.Path == selected {
			c.cursor = i
		}
	}
	if c.showBranches {
		return nil
	}
	return c.loadDiff(m)
}

// loadDiff reads the selected file's diff unless it is already read.
func (c *changesApp) loadDiff(m *Model) tea.Cmd {
	f, ok := c.selected()
	if !ok {
		return nil
	}
	if _, read := c.diffs[f.Path]; read {
		return nil
	}
	c.diffs[f.Path] = &fileDiff{loading: true}
	root := m.projectRoot()
	return func() tea.Msg {
		text, truncated, err := project.Diff(context.Background(), root, f)
		return diffLoadedMsg{f.Path, text, truncated, err}
	}
}

func (m *Model) diffLoaded(msg diffLoadedMsg) {
	if c := m.changesWindow(); c != nil {
		d := &fileDiff{text: msg.text, truncated: msg.truncated}
		if msg.err != nil {
			d.err = msg.err.Error()
		}
		c.diffs[msg.path] = d
	}
}

// agentState is a file the agent keeps for itself under .archymedes/ — sessions, checkpoints,
// journals — not work in the project, so it stays out of Changes. Saved prompts
// (.archymedes/commands/) are the person's own, and stay in.
func agentState(path string) bool {
	return strings.HasPrefix(path, ".archymedes/") && !strings.HasPrefix(path, ".archymedes/commands/")
}

func (c *changesApp) selected() (project.Change, bool) {
	if c.cursor < 0 || c.cursor >= len(c.files) {
		return project.Change{}, false
	}
	return c.files[c.cursor], true
}

func (c *changesApp) choose(m *Model, i int) tea.Cmd {
	if i == c.cursor || i < 0 || i >= len(c.files) {
		return nil
	}
	c.cursor, c.scroll, c.line = i, 0, -1
	return c.loadDiff(m)
}

func (c *changesApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	if c.showBranches {
		return c.br.handle(m, c, msg)
	}
	page := max(m.windowHeight()-4, 1)
	switch msg.String() {
	case "esc", "q", "ctrl+c":
		return true, nil
	case "b":
		c.showBranches = true
		return false, c.br.loadDetail(m)
	case "r":
		return false, c.reload(m)
	case "left", "h":
		c.onDiff = false
	case "right", "l":
		// Onto the diff: ↑/↓ then pick a line, and enter comments on it.
		if f, ok := c.selected(); ok && c.diffs[f.Path] != nil {
			c.onDiff = true
			if c.line < 0 {
				c.moveLine(m, 1)
			}
		}
	case "up", "k":
		if c.onDiff {
			c.moveLine(m, -1)
			return false, nil
		}
		return false, c.choose(m, c.cursor-1)
	case "down", "j":
		if c.onDiff {
			c.moveLine(m, 1)
			return false, nil
		}
		return false, c.choose(m, c.cursor+1)
	case "pgdown", "shift+down":
		c.scroll += page
	case "pgup", "shift+up":
		c.scroll = max(c.scroll-page, 0)
	case "home", "g":
		if c.onDiff {
			c.scroll = 0
			return false, nil
		}
		return false, c.choose(m, 0)
	case "end":
		if c.onDiff {
			c.scroll = 1 << 20 // clamped when drawn
			return false, nil
		}
		return false, c.choose(m, len(c.files)-1)
	case "space":
		return false, c.read(m) // look at the whole diff, in the reader
	case "n", "p":
		c.jumpHunk(msg.String() == "n")
	case "]", "[":
		c.moveLine(m, map[string]int{"]": 1, "[": -1}[msg.String()])
	case "c":
		return false, c.commentOnLine(m)
	case "@":
		if f, ok := c.selected(); ok {
			m.input.area.InsertString("@" + f.Path + " ")
			return true, m.toast(toastInfo, "@"+f.Path+" added to your message")
		}
	case "enter":
		if c.onDiff {
			return false, c.commentOnLine(m)
		}
		return false, c.read(m)
	}
	return false, nil
}

// read opens the selected file's diff in a reader.
func (c *changesApp) read(m *Model) tea.Cmd {
	if f, ok := c.selected(); ok {
		if d := c.diffs[f.Path]; d != nil && d.text != "" {
			m.openWindow(newPager(m, "diff "+f.Path, diffRows(m.th, d.text, max(m.width-12, 20))))
		}
	}
	return nil
}

// listWidth is the file list's width beside the diff in a window width wide.
func listWidth(width int) int { return max(min(width*2/5, 46), min(width, 18)) }

// wheelAt scrolls the pane under the pointer: the list moves a file, the diff three rows.
func (c *changesApp) wheelAt(m *Model, up bool, x, _ int) tea.Cmd {
	if c.showBranches {
		return c.br.wheelAt(m, up, x)
	}
	step := map[bool]int{true: -1, false: 1}[up]
	if x < listWidth(m.width) {
		return c.choose(m, c.cursor+step)
	}
	c.scroll = max(c.scroll+step*wheelStep, 0)
	return nil
}

// jumpHunk scrolls to the next (or previous) hunk of the shown diff.
func (c *changesApp) jumpHunk(next bool) {
	f, ok := c.selected()
	if !ok || c.diffs[f.Path] == nil {
		return
	}
	hunks := c.diffs[f.Path].hunks
	if next {
		for _, h := range hunks {
			if h > c.scroll {
				c.scroll = h
				return
			}
		}
		return
	}
	for i := len(hunks) - 1; i >= 0; i-- {
		if hunks[i] < c.scroll {
			c.scroll = hunks[i]
			return
		}
	}
	c.scroll = 0
}

func (c *changesApp) rowCount() int { return len(c.files) }

func (c *changesApp) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	for _, tab := range []struct {
		id       string
		branches bool
	}{{"chg:tab:files", false}, {"chg:tab:branches", true}} {
		if m.zones.frame.Get(tab.id).InBounds(msg) && c.showBranches != tab.branches {
			c.showBranches = tab.branches
			if tab.branches {
				return c.br.loadDetail(m)
			}
			return c.loadDiff(m)
		}
	}
	if c.showBranches {
		return c.br.click(m, msg)
	}
	if i, ok := c.list.clicked(m.zones.frame, msg, len(c.files)); ok {
		c.onDiff = false
		if i == c.cursor {
			return c.read(m) // a second click on the file reads its diff
		}
		return c.choose(m, i)
	}
	if f, ok := c.selected(); ok && c.diffs[f.Path] != nil {
		for row, ref := range c.diffs[f.Path].refs {
			if row >= c.scroll && ref.ok && m.zones.frame.Get(fmt.Sprintf("chgline:%d", row)).InBounds(msg) {
				open := c.onDiff && c.line == row
				c.onDiff, c.line = true, row
				if open {
					return c.commentOnLine(m) // a second click on the line comments on it
				}
				return nil
			}
		}
	}
	return nil
}

func (c *changesApp) view(m *Model) string {
	th := m.th
	width, height := m.width, max(m.windowHeight(), 1)
	title := " " + th.Title.Render("Changes") + "  " + c.tabs(m) + th.Faint.Render("  "+path.Base(m.projectRoot())) + c.headLine(m)
	right := ""
	if c.loading || c.br.loading {
		right = m.spin.View() + " "
	}
	if c.showBranches {
		rows := []string{spread(title, right, width)}
		rows = append(rows, c.br.body(m, width, height-2)...)
		return strings.Join(append(rows, m.hintBar(width, button{"enter", "read"}, button{"R", "review a branch"}, button{"b", "files"}, button{"r", "refresh"}, button{"q", "close"})), "\n")
	}
	var added, removed int
	for _, f := range c.files {
		added, removed = added+f.Added, removed+f.Removed
	}
	if c.loaded && len(c.files) > 0 {
		right += th.Faint.Render(plural(len(c.files), "file")+" · ") + th.OK.Render(fmt.Sprintf("+%d", added)) + " " + th.Bad.Render(fmt.Sprintf("−%d", removed)) + " "
	}
	rows := []string{spread(title, right, width)}
	body := height - 2

	switch {
	case !c.loaded:
		rows = append(rows, centre([]string{m.spin.View() + th.Faint.Render(" reading what changed…")}, width, body)...)
	case c.notRepo:
		rows = append(rows, m.emptyState(gallery.OfTheme("greek", 1), []string{
			th.Body.Render("This folder is not a git repository."),
			th.Faint.Render("Changes are shown against the last commit, so they need one: git init."),
		}, width, body)...)
	case c.err != "":
		rows = append(rows, centre([]string{th.Bad.Render(ansi.Truncate(c.err, width-4, "…"))}, width, body)...)
	case len(c.files) == 0:
		rows = append(rows, m.emptyState(gallery.OfTheme("math", 2), []string{
			th.Body.Render("Nothing has changed since the last commit."),
			th.Faint.Render("When the agent edits a file, it shows up here. r reads again."),
		}, width, body)...)
	default:
		rows = append(rows, c.split(m, width, body)...)
	}
	buttons := []button{{"enter", "read"}, {"→", "lines"}, {"c", "comment"}, {"@", "mention"}, {"b", "branches"}, {"r", "refresh"}, {"q", "close"}}
	if c.onDiff {
		buttons = []button{{"enter", "comment"}, {"←", "files"}, {"n", "next hunk"}, {"space", "read"}, {"q", "close"}}
	}
	foot := m.hintBar(width, buttons...)
	if len(m.comments) > 0 {
		foot = " " + th.Highlight.Render(plural(len(m.comments), "comment")+" for your next message") + foot
	}
	rows = append(rows, ansi.Truncate(foot, width, "…"))
	return strings.Join(rows, "\n")
}

// tabs are the two views, the shown one bright; either is a click target.
func (c *changesApp) tabs(m *Model) string {
	th := m.th
	files, branches := th.Key.Render("Files"), th.Faint.Render("Branches")
	if c.showBranches {
		files, branches = th.Faint.Render("Files"), th.Key.Render("Branches")
	}
	return mark(m.zones.frame, "chg:tab:files", files) + th.Faint.Render(" · ") + mark(m.zones.frame, "chg:tab:branches", branches)
}

// headLine is where HEAD is, after the project's name: " on main ↑1", " at 3f2a1bc (detached)".
func (c *changesApp) headLine(m *Model) string {
	repo := c.br.repo
	switch {
	case repo.Head == "":
		return ""
	case repo.Detached:
		return m.th.Faint.Render(" at " + repo.Head + " (detached)")
	}
	line := m.th.Faint.Render(" on " + repo.Head)
	if track := trackText(repo.Ahead, repo.Behind, false); track != "" {
		line += " " + trackStyle(m, repo.Ahead, repo.Behind, false).Render(track)
	}
	return line
}

// split is the file list beside the selected file's diff.
func (c *changesApp) split(m *Model, width, height int) []string {
	th := m.th
	height = max(height, 0)
	listWidth := listWidth(width)
	diffWidth := max(width-listWidth-3, 0)
	most := 1
	for _, f := range c.files {
		most = max(most, f.Added+f.Removed)
	}
	c.list.zone, c.list.cursor = "chg", c.cursor
	from, to := c.list.window(len(c.files), height)
	var left []string
	for i := from; i < to; i++ {
		left = append(left, mark(m.zones.frame, fmt.Sprintf("chg:%d", i), c.fileRow(m, c.files[i], i == c.cursor && !c.onDiff, listWidth, most)))
	}
	var right []string
	if f, ok := c.selected(); ok && diffWidth > 10 {
		right = c.diffView(m, f, diffWidth, height)
	}
	edge := th.BorderColor
	if c.onDiff {
		edge = th.BorderFocus // the diff has the arrows
	}
	rule := lipgloss.NewStyle().Foreground(edge).Render("│")
	out := make([]string, 0, height)
	for i := 0; i < height; i++ {
		row := padRight(at(left, i), listWidth)
		if diffWidth > 0 {
			row += " " + rule + " " + ansi.Truncate(at(right, i), diffWidth, "")
		}
		out = append(out, row)
	}
	return out
}

// statusGlyph is a change's one-letter status, coloured by what it means.
func statusGlyph(m *Model, f project.Change) string {
	th := m.th
	switch f.Status {
	case "added":
		return th.OK.Render("A")
	case "deleted":
		return th.Bad.Render("D")
	case "renamed":
		return lipgloss.NewStyle().Foreground(th.Secondary).Render("R")
	case "untracked":
		return th.OK.Render("?")
	case "conflict":
		return th.Bad.Render("!")
	}
	return th.Warn.Render("M")
}

// fileRow is one file in the list: status, path, counts, and a bar of its share of the change.
func (c *changesApp) fileRow(m *Model, f project.Change, selected bool, width, most int) string {
	th := m.th
	counts, bar := "bin", ""
	if !f.Binary {
		counts = fmt.Sprintf("+%d −%d", f.Added, f.Removed)
		// Up to five cells, split between added and removed, scaled to the biggest change.
		cells := max(1, (f.Added+f.Removed)*5/most)
		total := max(f.Added+f.Removed, 1)
		plus := (2*cells*f.Added + total) / (2 * total) // rounded, so a mostly-added file reads green
		bar = strings.Repeat("■", plus) + strings.Repeat("□", cells-plus)
	}
	tail := counts
	if bar != "" {
		tail += " " + bar
	}
	room := max(width-4-ansi.StringWidth(tail), 4)
	name := f.Path
	if f.From != "" {
		name = f.From + " → " + f.Path
	}
	name = padRight(truncateMiddle(name, room), room)
	if selected {
		// The selected row is one solid bar: plain text on the highlight, so its colours never fight.
		return lipgloss.NewStyle().Foreground(th.Text).Background(th.Tint(th.Primary, 0.35)).Bold(true).
			Render(padRight("›"+ansi.Strip(statusGlyph(m, f))+" "+name+" "+tail, width))
	}
	styledTail := th.Faint.Render(counts)
	if !f.Binary {
		plus := strings.Count(bar, "■")
		styledTail = th.OK.Render(fmt.Sprintf("+%d", f.Added)) + " " + th.Bad.Render(fmt.Sprintf("−%d", f.Removed)) +
			" " + th.OK.Render(strings.Repeat("■", plus)) + th.Bad.Render(strings.Repeat("■", len([]rune(bar))-plus))
	}
	return " " + statusGlyph(m, f) + " " + name + " " + styledTail
}

func truncateMiddle(s string, width int) string {
	if ansi.StringWidth(s) <= width || width < 5 {
		return ansi.Truncate(s, width, "…")
	}
	keep := width - 1
	head := keep / 3
	return ansi.Truncate(s, head, "") + "…" + ansi.TruncateLeft(s, ansi.StringWidth(s)-(keep-head), "")
}

// diffView is the selected file's diff, from the scroll position, height rows.
func (c *changesApp) diffView(m *Model, f project.Change, width, height int) []string {
	th := m.th
	d := c.diffs[f.Path]
	if d == nil || d.loading {
		return []string{m.spin.View() + th.Faint.Render(" reading the diff…")}
	}
	if d.err != "" {
		return []string{th.Bad.Render(ansi.Truncate(d.err, width, "…"))}
	}
	if d.rowsWidth != width {
		d.rows, d.rowsWidth = diffRows(m.th, d.text, width), width
		d.refs = diffLineRefs(d.text)
		d.hunks = nil
		for i, row := range d.rows {
			if strings.HasPrefix(ansi.Strip(row), "  ⋯") {
				d.hunks = append(d.hunks, i)
			}
		}
		if d.truncated {
			d.rows = append(d.rows, th.Warn.Render("… the rest is past "+strconv.Itoa(project.MaxDiffBytes>>20)+" MB; enter reads it in the pager"))
		}
	}
	if len(d.rows) == 0 {
		if f.Binary {
			return []string{th.Faint.Render("binary file; no lines to show")}
		}
		return []string{th.Faint.Render("no line changes (a mode or rename only)")}
	}
	c.scroll = min(c.scroll, max(len(d.rows)-height, 0))
	shown := slices.Clone(d.rows[c.scroll:min(c.scroll+height, len(d.rows))])
	defer func() {
		for i := range shown {
			shown[i] = mark(m.zones.frame, fmt.Sprintf("chgline:%d", c.scroll+i), shown[i]) // a line is a click target
		}
	}()
	// The chosen line and the commented ones are marked in the gutter's first column.
	for i := range shown {
		row := c.scroll + i
		if row >= len(d.refs) || !d.refs[row].ok {
			continue
		}
		commented := m.commentAt(f.Path, d.refs[row]) >= 0
		switch {
		case row == c.line && commented:
			shown[i] = th.Highlight.Render("◆") + ansi.Cut(shown[i], 1, width)
		case row == c.line:
			shown[i] = th.Highlight.Render("▸") + ansi.Cut(shown[i], 1, width)
		case commented:
			shown[i] = th.Warn.Render("◆") + ansi.Cut(shown[i], 1, width)
		}
	}
	return shown
}

// diffRows draws a unified diff for reading: git's headers dropped (the file is named above),
// each hunk opened by a quiet rule, every line with its old and new line numbers, and added and
// removed lines on a tint of their colour across the full width.
//
// A hunk whose place is not known (an edit drawn from its call, before the file was found) starts
// at line 0: its lines are drawn with no numbers rather than with wrong ones.
func diffRows(th theme.Theme, text string, width int) []string {
	var rows []string
	oldLine, newLine := 0, 0
	gutter := func(a, b int) string { return th.Faint.Render(fmt.Sprintf("%4s %4s ", lineNo(a), lineNo(b))) }
	codeWidth := max(width-10, 4)
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		line = strings.ReplaceAll(ansi.Strip(line), "\t", "    ")
		switch {
		case strings.HasPrefix(line, "diff --git"), strings.HasPrefix(line, "index "),
			strings.HasPrefix(line, "--- "), strings.HasPrefix(line, "+++ "), strings.HasPrefix(line, "similarity index"):
			continue
		case strings.HasPrefix(line, "new file mode"), strings.HasPrefix(line, "deleted file mode"),
			strings.HasPrefix(line, "rename from"), strings.HasPrefix(line, "rename to"), strings.HasPrefix(line, "Binary files"),
			strings.HasPrefix(line, "old mode"), strings.HasPrefix(line, "new mode"):
			rows = append(rows, th.Faint.Render("  "+line))
		case strings.HasPrefix(line, "@@"):
			oldLine, newLine = hunkStart(line)
			context := strings.TrimSpace(line[strings.LastIndex(line, "@@")+2:])
			label := "  ⋯ line " + strconv.Itoa(newLine)
			if newLine <= 0 {
				label = "  ⋯ edit"
			}
			if context != "" {
				label += " · " + context
			}
			rows = append(rows, lipgloss.NewStyle().Foreground(th.Secondary).Render(ansi.Truncate(label, width, "…")))
		case strings.HasPrefix(line, "+"):
			rows = append(rows, gutter(0, newLine)+lipgloss.NewStyle().Foreground(th.Success).Background(th.Tint(th.Success, 0.18)).Width(codeWidth).Render(ansi.Truncate(line, codeWidth, "…")))
			newLine = advance(newLine)
		case strings.HasPrefix(line, "-"):
			rows = append(rows, gutter(oldLine, 0)+lipgloss.NewStyle().Foreground(th.Error).Background(th.Tint(th.Error, 0.18)).Width(codeWidth).Render(ansi.Truncate(line, codeWidth, "…")))
			oldLine = advance(oldLine)
		case strings.HasPrefix(line, `\`):
			rows = append(rows, th.Faint.Render("  "+line))
		default:
			rows = append(rows, gutter(oldLine, newLine)+th.Body.Render(ansi.Truncate(line, codeWidth, "…")))
			oldLine = advance(oldLine)
			newLine = advance(newLine)
		}
	}
	return rows
}

// lineNo is a gutter's number, blank when it is not known.
func lineNo(n int) string {
	if n <= 0 {
		return ""
	}
	return strconv.Itoa(n)
}

// advance is the next line's number; an unknown one stays unknown.
func advance(n int) int {
	if n <= 0 {
		return 0
	}
	return n + 1
}

// hunkStart reads "@@ -12,5 +14,7 @@" as (12, 14).
func hunkStart(header string) (int, int) {
	var oldStart, newStart int
	for _, field := range strings.Fields(header) {
		if len(field) < 2 {
			continue
		}
		number, _, _ := strings.Cut(field[1:], ",")
		n, err := strconv.Atoi(number)
		if err != nil {
			continue
		}
		switch field[0] {
		case '-':
			oldStart = n
		case '+':
			newStart = n
		}
	}
	return oldStart, newStart
}
