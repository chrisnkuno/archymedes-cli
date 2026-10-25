package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/project"
)

// The Changes app's Branches view (b): the repository beyond the working tree — the branches,
// local and remote, with where each stands against its upstream; the worktrees checked out from
// the repository, child agents' among them; and the stash. The selected one is on the right: a
// branch's history as a graph and where it stands against HEAD, a worktree's changed files, a
// stash's patch. Read-only, like the files view.

type branchesLoadedMsg struct {
	repo project.Repository
	err  error
}

type branchDetailMsg struct {
	key    string
	detail *branchDetail
}

// branchRow is one row of the list: a section header, or an entry of the repository.
type branchRow struct {
	header string
	kind   string // "branch", "worktree", "stash"
	index  int    // into the repository's list of that kind
}

func (r branchRow) id() string { return r.kind + ":" + strconv.Itoa(r.index) }

// branchDetail is what the right side shows for one entry, read once per reload.
type branchDetail struct {
	loading   bool
	err       string
	history   *project.History
	changes   []project.Change
	patch     string
	truncated bool
	rows      []string // drawn, for rowsWidth
	rowsWidth int
}

type branchesView struct {
	loaded  bool
	loading bool
	err     string
	notRepo bool
	repo    project.Repository
	rows    []branchRow
	cursor  int // into rows, always on an entry
	scroll  int // the detail's first row
	details map[string]*branchDetail
}

func (b *branchesView) reload(m *Model) tea.Cmd {
	b.loading = true
	root := m.projectRoot()
	return func() tea.Msg {
		repo, err := project.Branches(context.Background(), root)
		return branchesLoadedMsg{repo, err}
	}
}

func (m *Model) branchesLoaded(msg branchesLoadedMsg) tea.Cmd {
	c := m.changesWindow()
	if c == nil {
		return nil
	}
	b := c.br
	selected := ""
	if r, ok := b.selected(); ok {
		selected = b.label(r)
	}
	b.loaded, b.loading, b.err, b.notRepo = true, false, "", false
	b.details = map[string]*branchDetail{}
	switch {
	case errors.Is(msg.err, project.ErrNotRepository):
		b.notRepo = true
	case msg.err != nil:
		b.err = msg.err.Error()
	}
	b.repo = msg.repo
	b.rows = b.rows[:0]
	section := func(title string, kind string, n int) {
		if n == 0 {
			return
		}
		b.rows = append(b.rows, branchRow{header: title + " " + strconv.Itoa(n)})
		for i := range n {
			b.rows = append(b.rows, branchRow{kind: kind, index: i})
		}
	}
	local, remote := splitRemote(b.repo.Branches)
	section("Local", "branch", local)
	section("Worktrees", "worktree", len(b.repo.Worktrees))
	if remote > 0 {
		b.rows = append(b.rows, branchRow{header: "Remote " + strconv.Itoa(remote)})
		for i := local; i < local+remote; i++ {
			b.rows = append(b.rows, branchRow{kind: "branch", index: i})
		}
	}
	section("Stash", "stash", len(b.repo.Stashes))
	// Stay on what was selected, if it is still there; else the first entry (the current branch).
	b.cursor = b.step(-1, 1)
	for i, r := range b.rows {
		if r.header == "" && selected != "" && b.label(r) == selected {
			b.cursor = i
		}
	}
	if !c.showBranches {
		return nil
	}
	return b.loadDetail(m)
}

// splitRemote counts local branches (listed first by project.Branches' sort within kinds) and remote ones.
func splitRemote(branches []project.Branch) (local, remote int) {
	for _, br := range branches {
		if br.Remote {
			remote++
		} else {
			local++
		}
	}
	return local, remote
}

// step is the next entry from row i in direction dir (headers are skipped), or i when there is none.
func (b *branchesView) step(i, dir int) int {
	for j := i + dir; j >= 0 && j < len(b.rows); j += dir {
		if b.rows[j].header == "" {
			return j
		}
	}
	return max(i, 0)
}

func (b *branchesView) selected() (branchRow, bool) {
	if b.cursor < 0 || b.cursor >= len(b.rows) || b.rows[b.cursor].header != "" {
		return branchRow{}, false
	}
	return b.rows[b.cursor], true
}

// label names an entry the way git does: the branch, the worktree's path, the stash ref.
func (b *branchesView) label(r branchRow) string {
	switch r.kind {
	case "branch":
		return b.repo.Branches[r.index].Name
	case "worktree":
		return b.repo.Worktrees[r.index].Path
	case "stash":
		return b.repo.Stashes[r.index].Ref
	}
	return ""
}

// loadDetail reads the selected entry's detail unless it is already read.
func (b *branchesView) loadDetail(m *Model) tea.Cmd {
	r, ok := b.selected()
	if !ok {
		return nil
	}
	key := r.id()
	if _, read := b.details[key]; read {
		return nil
	}
	b.details[key] = &branchDetail{loading: true}
	root := m.projectRoot()
	ctx := context.Background()
	switch r.kind {
	case "branch":
		name := b.repo.Branches[r.index].Name
		return func() tea.Msg {
			h, err := project.BranchHistory(ctx, root, name)
			return branchDetailMsg{key, &branchDetail{history: &h, err: errText(err)}}
		}
	case "worktree":
		w := b.repo.Worktrees[r.index]
		return func() tea.Msg {
			changes, err := project.WorktreeChanges(ctx, w)
			if errors.Is(err, os.ErrNotExist) {
				err = errors.New("its folder is gone; git worktree prune clears it")
			}
			return branchDetailMsg{key, &branchDetail{changes: changes, err: errText(err)}}
		}
	case "stash":
		ref := b.repo.Stashes[r.index].Ref
		return func() tea.Msg {
			patch, truncated, err := project.StashPatch(ctx, root, ref)
			return branchDetailMsg{key, &branchDetail{patch: patch, truncated: truncated, err: errText(err)}}
		}
	}
	return nil
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (m *Model) branchDetailLoaded(msg branchDetailMsg) {
	if c := m.changesWindow(); c != nil {
		c.br.details[msg.key] = msg.detail
	}
}

func (b *branchesView) choose(m *Model, i int) tea.Cmd {
	if i == b.cursor || i < 0 || i >= len(b.rows) || b.rows[i].header != "" {
		return nil
	}
	b.cursor, b.scroll = i, 0
	return b.loadDetail(m)
}

func (b *branchesView) handle(m *Model, c *changesApp, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	page := max(m.windowHeight()-4, 1)
	switch msg.String() {
	case "esc", "q", "ctrl+c":
		return true, nil
	case "b":
		c.showBranches = false
		return false, c.loadDiff(m)
	case "r":
		return false, c.reload(m)
	case "up", "k":
		return false, b.choose(m, b.step(b.cursor, -1))
	case "down", "j":
		return false, b.choose(m, b.step(b.cursor, 1))
	case "pgdown", "shift+down":
		b.scroll += page
	case "pgup", "shift+up":
		b.scroll = max(b.scroll-page, 0)
	case "home", "g":
		b.scroll = 0
	case "R":
		// Review a branch's commits against HEAD, as a pull request from it would show them.
		if r, ok := b.selected(); ok && r.kind == "branch" {
			branch := b.repo.Branches[r.index]
			if branch.Current {
				return false, m.toast(toastInfo, "That is HEAD: /review base <branch> reviews it against another")
			}
			return true, m.cmdReview("branch " + branch.Name)
		}
	case "enter", "space":
		b.read(m)
	}
	return false, nil
}

// read opens the selected entry's detail in a reader.
func (b *branchesView) read(m *Model) {
	if r, ok := b.selected(); ok {
		if d := b.details[r.id()]; d != nil && !d.loading {
			m.openWindow(newPager(m, b.label(r), b.detailRows(m, r, d, max(m.width-12, 20))))
		}
	}
}

// click selects an entry; a second click on it reads its detail.
func (b *branchesView) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	for i := range b.rows {
		if m.zones.frame.Get(fmt.Sprintf("br:%d", i)).InBounds(msg) {
			if i == b.cursor {
				b.read(m)
				return nil
			}
			return b.choose(m, i)
		}
	}
	return nil
}

// wheelAt scrolls the pane under the pointer: the list moves an entry, the detail three rows.
func (b *branchesView) wheelAt(m *Model, up bool, x int) tea.Cmd {
	step := map[bool]int{true: -1, false: 1}[up]
	if x < listWidth(m.width) {
		return b.choose(m, b.step(b.cursor, step))
	}
	b.scroll = max(b.scroll+step*wheelStep, 0)
	return nil
}

// body is the view under the title: the list beside the selected entry's detail.
func (b *branchesView) body(m *Model, width, height int) []string {
	th := m.th
	height = max(height, 0)
	switch {
	case !b.loaded:
		return centre([]string{m.spin.View() + th.Faint.Render(" reading the branches…")}, width, height)
	case b.notRepo:
		return centre([]string{th.Body.Render("This folder is not a git repository.")}, width, height)
	case b.err != "":
		return centre([]string{th.Bad.Render(ansi.Truncate(b.err, width-4, "…"))}, width, height)
	case len(b.rows) == 0:
		return centre([]string{th.Faint.Render("No branches yet: the first commit makes one.")}, width, height)
	}
	listWidth := max(min(width*2/5, 46), min(width, 18))
	detailWidth := max(width-listWidth-3, 0)
	first := max(b.cursor-height+1, 0)
	var left []string
	for i := first; i < len(b.rows) && len(left) < height; i++ {
		left = append(left, mark(m.zones.frame, fmt.Sprintf("br:%d", i), b.listRow(m, b.rows[i], i == b.cursor, listWidth)))
	}
	var right []string
	if r, ok := b.selected(); ok && detailWidth > 10 {
		right = b.detailView(m, r, detailWidth, height)
	}
	rule := lipgloss.NewStyle().Foreground(th.BorderColor).Render("│")
	out := make([]string, 0, height)
	for i := range height {
		row := padRight(at(left, i), listWidth)
		if detailWidth > 0 {
			row += " " + rule + " " + ansi.Truncate(at(right, i), detailWidth, "")
		}
		out = append(out, row)
	}
	return out
}

// listRow is one row of the list: a header, or an entry with what matters about it on the right.
func (b *branchesView) listRow(m *Model, r branchRow, selected bool, width int) string {
	th := m.th
	if r.header != "" {
		return " " + th.Faint.Render(r.header)
	}
	var marker, name, tail string
	var styledTail []string
	now := time.Now()
	switch r.kind {
	case "branch":
		br := b.repo.Branches[r.index]
		marker, name = " ", br.Name
		if br.Current {
			marker = "*"
		}
		if track := trackText(br.Ahead, br.Behind, br.Gone); track != "" {
			styledTail = append(styledTail, trackStyle(m, br.Ahead, br.Behind, br.Gone).Render(track))
		}
		if br.Worktree != "" {
			styledTail = append(styledTail, th.Faint.Render("worktree"))
		}
		styledTail = append(styledTail, th.Faint.Render(relativeTime(br.When.UnixMilli(), now)))
	case "worktree":
		w := b.repo.Worktrees[r.index]
		marker, name = " ", b.worktreeName(m, w)
		if w.Current {
			marker = "*"
		}
		on := w.Branch
		if on == "" {
			on = "detached " + w.Commit
		}
		styledTail = append(styledTail, th.Faint.Render(on))
		switch {
		case w.Prunable:
			styledTail = append(styledTail, th.Bad.Render("gone"))
		case w.Agent:
			styledTail = append(styledTail, lipgloss.NewStyle().Foreground(th.Secondary).Render("agent"))
		}
	case "stash":
		s := b.repo.Stashes[r.index]
		marker, name = " ", s.Subject
		styledTail = append(styledTail, th.Faint.Render(relativeTime(s.When.UnixMilli(), now)))
	}
	// A narrow list keeps the name readable: the least of the tail (the age, last) goes first.
	for len(styledTail) > 1 && width-4-ansi.StringWidth(ansi.Strip(strings.Join(styledTail, " "))) < 10 {
		styledTail = styledTail[:len(styledTail)-1]
	}
	tail = ansi.Strip(strings.Join(styledTail, " "))
	room := max(width-4-ansi.StringWidth(tail), 4)
	name = padRight(truncateMiddle(name, room), room)
	if selected {
		return lipgloss.NewStyle().Foreground(th.Text).Background(th.Tint(th.Primary, 0.35)).Bold(true).
			Render(padRight("›"+marker+" "+name+" "+tail, width))
	}
	if marker == "*" {
		marker = th.OK.Render(marker)
	}
	return " " + marker + " " + th.Body.Render(name) + " " + strings.Join(styledTail, " ")
}

// worktreeName is a worktree's path as read from here: "this checkout", relative inside the
// project, the home folder as ~ outside it.
func (b *branchesView) worktreeName(m *Model, w project.Worktree) string {
	if w.Current {
		return "this checkout"
	}
	root := m.projectRoot()
	if len(b.repo.Worktrees) > 0 {
		root = b.repo.Worktrees[0].Path
	}
	if rel, err := filepath.Rel(root, w.Path); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(w.Path, home+string(filepath.Separator)) {
		return "~" + strings.TrimPrefix(w.Path, home)
	}
	return w.Path
}

// trackText is "↑2 ↓1", "gone", or "" when there is nothing to say.
func trackText(ahead, behind int, gone bool) string {
	if gone {
		return "gone"
	}
	var parts []string
	if ahead > 0 {
		parts = append(parts, "↑"+strconv.Itoa(ahead))
	}
	if behind > 0 {
		parts = append(parts, "↓"+strconv.Itoa(behind))
	}
	return strings.Join(parts, " ")
}

func trackStyle(m *Model, ahead, behind int, gone bool) lipgloss.Style {
	switch {
	case gone:
		return m.th.Bad
	case behind > 0:
		return m.th.Warn
	}
	return m.th.OK
}

// detailView is the selected entry's detail, from the scroll position, height rows.
func (b *branchesView) detailView(m *Model, r branchRow, width, height int) []string {
	th := m.th
	d := b.details[r.id()]
	if d == nil || d.loading {
		return []string{m.spin.View() + th.Faint.Render(" reading…")}
	}
	if d.rowsWidth != width {
		d.rows, d.rowsWidth = b.detailRows(m, r, d, width), width
	}
	b.scroll = min(b.scroll, max(len(d.rows)-height, 0))
	return d.rows[b.scroll:min(b.scroll+height, len(d.rows))]
}

// detailRows draws one entry's detail at width: a heading of two lines, then its history, its
// changed files or its patch.
func (b *branchesView) detailRows(m *Model, r branchRow, d *branchDetail, width int) []string {
	th := m.th
	var rows []string
	now := time.Now()
	switch r.kind {
	case "branch":
		br := b.repo.Branches[r.index]
		rows = append(rows, th.Title.Render(br.Name)+th.Faint.Render("  "+br.Commit))
		rows = append(rows, b.standing(m, br, d.history))
		if br.Worktree != "" {
			rows = append(rows, th.Faint.Render("checked out at "+br.Worktree))
		}
	case "worktree":
		w := b.repo.Worktrees[r.index]
		on := "on " + w.Branch
		if w.Branch == "" {
			on = "detached at " + w.Commit
		}
		rows = append(rows, th.Title.Render(b.worktreeName(m, w)), th.Faint.Render(on+" · "+w.Path))
	case "stash":
		s := b.repo.Stashes[r.index]
		rows = append(rows, th.Title.Render(s.Ref)+th.Faint.Render("  "+relativeTime(s.When.UnixMilli(), now)), th.Body.Render(s.Subject))
	}
	rows = append(rows, "")
	if d.err != "" {
		return append(rows, th.Bad.Render(ansi.Truncate(d.err, width, "…")))
	}
	switch r.kind {
	case "branch":
		for _, c := range d.history.Commits {
			rows = append(rows, commitRow(m, c, width, now))
		}
	case "worktree":
		if len(d.changes) == 0 {
			return append(rows, th.Faint.Render("Nothing changed in this checkout since its last commit."))
		}
		for _, f := range d.changes {
			counts := th.Faint.Render("bin")
			if !f.Binary {
				counts = th.OK.Render(fmt.Sprintf("+%d", f.Added)) + " " + th.Bad.Render(fmt.Sprintf("−%d", f.Removed))
			}
			rows = append(rows, statusGlyph(m, project.Change{Status: f.Status})+" "+th.Body.Render(truncateMiddle(f.Path, max(width-16, 8)))+" "+counts)
		}
	case "stash":
		rows = append(rows, diffRows(m, d.patch, width)...)
		if d.truncated {
			rows = append(rows, th.Warn.Render("… the rest is past "+strconv.Itoa(project.MaxDiffBytes>>20)+" MB"))
		}
	}
	return rows
}

// standing says where a branch is: against its upstream when it is the current one, against HEAD
// otherwise.
func (b *branchesView) standing(m *Model, br project.Branch, h *project.History) string {
	th := m.th
	if br.Current {
		switch {
		case br.Upstream == "":
			return th.Faint.Render("checked out here · no upstream")
		case br.Gone:
			return th.Bad.Render("checked out here · " + br.Upstream + " is gone")
		case br.Ahead == 0 && br.Behind == 0:
			return th.Faint.Render("checked out here · up to date with " + br.Upstream)
		}
		return th.Faint.Render("checked out here · ") + trackStyle(m, br.Ahead, br.Behind, false).Render(aheadBehind(br.Ahead, br.Behind)+" "+br.Upstream)
	}
	if h == nil {
		return ""
	}
	head := b.repo.Head
	if h.Ahead == 0 && h.Behind == 0 {
		return th.Faint.Render("same as " + head)
	}
	return trackStyle(m, h.Ahead, h.Behind, false).Render(aheadBehind(h.Ahead, h.Behind) + " " + head)
}

// aheadBehind is "2 ahead of", "1 behind", "2 ahead of, 1 behind" — read before a branch's name.
func aheadBehind(ahead, behind int) string {
	switch {
	case ahead > 0 && behind > 0:
		return fmt.Sprintf("%d ahead, %d behind", ahead, behind)
	case ahead > 0:
		return fmt.Sprintf("%d ahead of", ahead)
	}
	return fmt.Sprintf("%d behind", behind)
}

// commitRow is one row of a graph log: the graph, the hash, the refs pointing at it, the subject,
// and who and when, faint.
func commitRow(m *Model, c project.Commit, width int, now time.Time) string {
	th := m.th
	graph := th.Faint.Render(c.Graph)
	if c.Hash == "" {
		return graph
	}
	line := graph + lipgloss.NewStyle().Foreground(th.Secondary).Render(c.Hash) + " "
	if c.Refs != "" {
		line += th.Warn.Render("("+c.Refs+")") + " "
	}
	line += th.Body.Render(c.Subject) + th.Faint.Render("  "+c.Author+", "+relativeTime(c.When.UnixMilli(), now))
	return ansi.Truncate(line, width, "…")
}
