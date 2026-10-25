package tui

import (
	"context"
	"fmt"
	"path"
	"strings"
	"time"

	"charm.land/bubbles/v2/tree"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/project"
)

// The project view (/files): Bubbles' tree over what git considers the project, with the selected
// file previewed beside it. Enter opens a file in the pager; @ hands its path to the agent by
// putting @path into the input, which is how a file is mentioned.

const previewBytes = 64 << 10

// fileEntry is a node's value: the tree draws String(), the view acts on path.
type fileEntry struct {
	name, path string
	dir        bool
}

func (e fileEntry) String() string {
	if e.dir {
		return e.name + "/"
	}
	return e.name
}

type filesLoadedMsg struct {
	files     []string
	truncated bool
	err       error
}

type filesView struct {
	tree      tree.Model
	loaded    bool
	err       string
	count     int
	truncated bool
	preview   map[string][]string // rendered preview by path, for the current width
	width     int
	shownPath string // the file the preview shows, and how far it is scrolled
	scroll    int
}

func (m *Model) openFiles() tea.Cmd {
	for _, w := range m.windows {
		if f, ok := w.(*filesView); ok {
			m.openWindow(f) // already open: focus it, as it was left
			return nil
		}
	}
	m.openWindow(&filesView{preview: map[string][]string{}})
	return m.listFiles()
}

// listFiles reads the project's file list in the background (filesLoadedMsg).
func (m *Model) listFiles() tea.Cmd {
	m.filesLoading = true
	root := m.projectRoot()
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		files, truncated, err := project.Files(ctx, root)
		return filesLoadedMsg{files, truncated, err}
	}
}

// projectRoot is the directory the session works in.
func (m *Model) projectRoot() string {
	if root := m.session.Info.Root; root != "" {
		return root
	}
	return m.opts.Cwd
}

func (m *Model) filesLoaded(msg filesLoadedMsg) {
	m.knownFiles, m.input.files, m.filesLoading = msg.files, msg.files, false
	m.input.refreshCompletions()
	if s, ok := m.overlay.(*startMenu); ok {
		s.files = msg.files // the start menu searches files as soon as they are known
		s.refilter()
	}
	if f, ok := windowOf[*finder](m); ok {
		f.reload(m)
	}
	var f *filesView
	for _, w := range m.windows {
		if view, ok := w.(*filesView); ok {
			f = view
		}
	}
	if f == nil {
		return
	}
	f.loaded, f.count, f.truncated = true, len(msg.files), msg.truncated
	if msg.err != nil {
		f.err = msg.err.Error()
		return
	}
	f.tree = tree.New(buildTree(path.Base(m.projectRoot()), msg.files), 40, 10)
	f.tree.SetShowHelp(false)
	f.tree.SetCursorCharacter("›")
	f.tree.SetOpenCharacter("▾")
	f.tree.SetClosedCharacter("▸")
	styles := tree.DefaultStyles(!m.th.Light)
	styles.NodeStyle, styles.ParentNodeStyle = m.th.Body, m.th.Highlight
	styles.SelectedNodeStyle = lipgloss.NewStyle().Foreground(m.th.Bg).Background(m.th.Primary).Bold(true)
	styles.RootNodeStyle, styles.CursorStyle = m.th.Title, m.th.Title
	styles.EnumeratorStyle, styles.IndenterStyle, styles.OpenIndicatorStyle = m.th.Faint, m.th.Faint, m.th.Faint
	f.tree.SetStyles(styles)
	f.tree.Down() // the cursor starts inside the project, not on its root (enter there folds everything)
}

// buildTree turns sorted relative paths into directory nodes (closed) and file leaves.
func buildTree(rootName string, files []string) *tree.Node {
	type dir struct {
		node     *tree.Node
		children map[string]*dir
		order    []string
		files    []fileEntry
	}
	top := &dir{node: tree.Root(fileEntry{name: rootName, dir: true}), children: map[string]*dir{}}
	for _, file := range files {
		parts := strings.Split(file, "/")
		d := top
		for i, part := range parts[:len(parts)-1] {
			child, ok := d.children[part]
			if !ok {
				child = &dir{node: tree.Root(fileEntry{name: part, path: strings.Join(parts[:i+1], "/"), dir: true}), children: map[string]*dir{}}
				d.children[part] = child
				d.order = append(d.order, part)
			}
			d = child
		}
		d.files = append(d.files, fileEntry{name: parts[len(parts)-1], path: file})
	}
	// Directories first, then files, each in name order; every directory starts closed.
	var attach func(d *dir)
	attach = func(d *dir) {
		for _, name := range d.order {
			child := d.children[name]
			attach(child)
			d.node.Child(child.node.Close())
		}
		for _, file := range d.files {
			d.node.Child(file)
		}
	}
	attach(top)
	return top.node
}

// selected is the entry under the cursor.
func (f *filesView) selected() (fileEntry, bool) {
	for _, node := range f.tree.Root().AllNodes() {
		if node.IsSelected() {
			entry, ok := node.GivenValue().(fileEntry)
			return entry, ok
		}
	}
	return fileEntry{}, false
}

func (f *filesView) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "q", "ctrl+c":
		return true, nil
	}
	if !f.loaded || f.err != "" {
		return false, nil
	}
	entry, ok := f.selected()
	switch msg.String() {
	case "@":
		if ok && entry.path != "" {
			m.input.area.InsertString("@" + entry.path + " ")
			return true, m.toast(toastInfo, "@"+entry.path+" added to your message")
		}
		return false, nil
	case "enter", "right", "l", "space":
		if ok && !entry.dir {
			return false, m.openFile(entry.path)
		}
	}
	var cmd tea.Cmd
	f.tree, cmd = f.tree.Update(msg)
	return false, cmd
}

// treeWidth is the tree's width beside the preview in a window width wide.
func treeWidth(width int) int { return max(min(width*2/5, 48), min(width, 16)) }

// wheelAt scrolls the pane under the pointer: the tree moves the selection, the preview its text.
func (f *filesView) wheelAt(m *Model, up bool, x, _ int) tea.Cmd {
	if !f.loaded || f.err != "" {
		return nil
	}
	if x < treeWidth(m.width) {
		if up {
			f.tree.Up()
		} else {
			f.tree.Down()
		}
		return nil
	}
	f.scroll = max(f.scroll+map[bool]int{true: -wheelStep, false: wheelStep}[up], 0)
	return nil
}

// click selects a row of the tree; a second click on it opens the file, or folds the folder.
func (f *filesView) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	if !f.loaded || f.err != "" {
		return nil
	}
	for i := range max(m.windowHeight()-2, 1) {
		if !m.zones.frame.Get(fmt.Sprintf("ftree:%d", i)).InBounds(msg) {
			continue
		}
		target := f.tree.ViewportYOffset() + i
		if target >= f.tree.Root().Size() {
			return nil
		}
		if target != f.tree.YOffset() {
			f.tree.SetYOffset(target)
			return nil
		}
		if entry, ok := f.selected(); ok && !entry.dir {
			return m.openFile(entry.path)
		}
		f.tree.ToggleCurrentNode()
		return nil
	}
	return nil
}

// openFile shows a file in a reader window, highlighted for its language.
func (m *Model) openFile(rel string) tea.Cmd {
	text, note := project.Preview(m.projectRoot(), rel, 1<<20)
	if text == "" && note != "" {
		return m.toast(toastWarn, rel+": "+note)
	}
	m.openWindow(newPager(m, rel, m.codeLines(rel, text, max(m.width-10, 20))))
	if note != "" {
		return m.toast(toastInfo, note)
	}
	return nil
}

// codeLines renders a file for reading: markdown as markdown, code through Glamour's highlighter.
func (m *Model) codeLines(rel, text string, width int) []string {
	lang := project.Language(rel)
	var out string
	if lang == "markdown" {
		out = m.md.Render(text, width)
	} else {
		out = m.md.Render("```"+lang+"\n"+strings.TrimRight(text, "\n")+"\n```", width)
	}
	return strings.Split(out, "\n")
}

func (f *filesView) view(m *Model) string {
	th := m.th
	height := max(m.windowHeight()-2, 1)
	treeWidth := treeWidth(m.width)
	previewWidth := max(m.width-treeWidth-3, 0)

	title := " " + th.Title.Render("files") + th.Faint.Render("  "+path.Base(m.projectRoot()))
	right := ""
	if f.loaded && f.err == "" {
		right = th.Faint.Render(plural(f.count, "file") + " ")
		if f.truncated {
			right = th.Warn.Render("first " + plural(f.count, "file") + " ")
		}
	}
	header := spread(title, right, m.width)

	var left, preview []string
	switch {
	case !f.loaded:
		left = []string{m.spin.View() + th.Faint.Render(" listing the project…")}
	case f.err != "":
		left = strings.Split(th.Bad.Render(ansi.Wrap(f.err, treeWidth, "")), "\n")
	default:
		f.tree.SetSize(treeWidth, height)
		left = strings.Split(f.tree.View(), "\n")
		if entry, ok := f.selected(); ok && previewWidth > 10 {
			if entry.path != f.shownPath {
				f.shownPath, f.scroll = entry.path, 0 // another file: from its top
			}
			if entry.dir {
				preview = f.directorySummary(m, previewWidth)
			} else {
				preview = f.previewOf(m, entry.path, previewWidth)
			}
			f.scroll = min(f.scroll, max(len(preview)-height, 0))
			preview = preview[f.scroll:]
		}
	}
	rule := lipgloss.NewStyle().Foreground(th.BorderColor).Render("│")
	rows := []string{header}
	for i := 0; i < height; i++ {
		row := mark(m.zones.frame, fmt.Sprintf("ftree:%d", i), padRight(ansi.Truncate(at(left, i), treeWidth, "…"), treeWidth))
		if previewWidth > 0 {
			row += " " + rule + " " + ansi.Truncate(at(preview, i), previewWidth, "")
		}
		rows = append(rows, row)
	}
	rows = append(rows, m.hintBar(m.width, button{"enter", "open"}, button{"←", "fold"}, button{"→", "unfold"}, button{"@", "mention"}, button{"q", "close"}))
	return strings.Join(rows, "\n")
}

func (f *filesView) previewOf(m *Model, rel string, width int) []string {
	if f.width != width {
		f.preview, f.width = map[string][]string{}, width
	}
	if lines, ok := f.preview[rel]; ok {
		return lines
	}
	text, note := project.Preview(m.projectRoot(), rel, previewBytes)
	var lines []string
	if text == "" {
		lines = []string{m.th.Faint.Render(note)}
	} else {
		lines = m.codeLines(rel, text, width)
	}
	f.preview[rel] = lines
	return lines
}

// directorySummary is what a selected directory holds: its entries, folders first.
func (f *filesView) directorySummary(m *Model, width int) []string {
	for _, node := range f.tree.Root().AllNodes() {
		if !node.IsSelected() {
			continue
		}
		children := node.ChildNodes()
		lines := []string{m.th.Title.Render(node.Value()) + m.th.Faint.Render(" · "+plural(len(children), "item"))}
		for _, child := range children {
			lines = append(lines, "  "+m.th.Body.Render(ansi.Truncate(child.Value(), width-2, "…")))
		}
		return lines
	}
	return nil
}

func at(lines []string, i int) string {
	if i < len(lines) {
		return lines[i]
	}
	return ""
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}
