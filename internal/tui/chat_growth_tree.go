package tui

import (
	"fmt"
	"math"
	"path"
	"regexp"
	"sort"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// The growth tree, as values: folders as branches, measured in code lines, opened where the code
// is, with the plan's items as buds on the branches they are about. Pure, so it is tested without
// a Model; the panel only draws what growthTree returns.

// growthNode is one branch: a folder (or a chain of single folders, "internal/core"), with every
// file below it counted.
type growthNode struct {
	name, path     string // name as drawn; path from the root, "" for the trunk
	lines, base    int    // code lines now, and at the first measure
	added, removed int    // this session's edits below it
	seed           bool   // planned: named by the plan, no code yet
	children       []*growthNode
	open           bool // its children are drawn
	buds           []growthBud
	depth          int
}

func (n *growthNode) grown() int { return max(n.lines-n.base, 0) }

// buildGrowthTree is the folder tree of the counted files, chains of single folders joined.
func buildGrowthTree(lines, base map[string]int, edits map[string][2]int) *growthNode {
	trunk := &growthNode{}
	dirs := map[string]*growthNode{"": trunk}
	var node func(dir string) *growthNode
	node = func(dir string) *growthNode {
		if n, ok := dirs[dir]; ok {
			return n
		}
		parent := node(parentDir(dir))
		n := &growthNode{name: path.Base(dir), path: dir}
		parent.children = append(parent.children, n)
		dirs[dir] = n
		return n
	}
	each := func(files map[string]int, apply func(n *growthNode, v int)) {
		for file, v := range files {
			for n := node(fileDir(file)); ; {
				apply(n, v)
				if n == trunk {
					break
				}
				n = dirs[parentDir(n.path)]
			}
		}
	}
	each(lines, func(n *growthNode, v int) { n.lines += v })
	each(base, func(n *growthNode, v int) { n.base += v })
	for file, e := range edits {
		if !isCode(file) {
			continue
		}
		for n := node(fileDir(file)); ; {
			n.added, n.removed = n.added+e[0], n.removed+e[1]
			if n == trunk {
				break
			}
			n = dirs[parentDir(n.path)]
		}
	}
	trunk.compress()
	trunk.sortChildren()
	return trunk
}

func fileDir(file string) string {
	if d := path.Dir(file); d != "." {
		return d
	}
	return ""
}

func parentDir(dir string) string {
	if d := path.Dir(dir); d != "." && d != "/" {
		return d
	}
	return ""
}

// compress joins a folder holding nothing but one folder with it: "internal" → "internal/core".
func (n *growthNode) compress() {
	for _, c := range n.children {
		for len(c.children) == 1 && c.lines == c.children[0].lines && c.base == c.children[0].base {
			only := c.children[0]
			only.name = c.name + "/" + only.name
			*c = *only
		}
		c.compress()
	}
}

func (n *growthNode) sortChildren() {
	sort.SliceStable(n.children, func(a, b int) bool {
		x, y := n.children[a], n.children[b]
		if x.lines != y.lines {
			return x.lines > y.lines
		}
		return x.name < y.name
	})
	for _, c := range n.children {
		c.sortChildren()
	}
}

// maxBranches is how many branches one folder shows before "… n more".
const maxBranches = 6

// shownChildren are the branches drawn under an open node.
func (n *growthNode) shownChildren() (shown []*growthNode, more, moreLines int) {
	for i, c := range n.children {
		if c.lines == 0 && c.base == 0 && !c.seed && c.added == 0 {
			continue
		}
		if len(shown) == maxBranches {
			for _, rest := range n.children[i:] {
				more++
				moreLines += rest.lines
			}
			break
		}
		shown = append(shown, c)
	}
	return shown, more, moreLines
}

// openBranches decides which branches are drawn open within budget rows: the trunk, then always
// the heaviest closed branch next, while it holds a fair share of the code and its branches fit.
// Greedy by weight is what a person scanning the tree wants: the detail is where the code is.
func (n *growthNode) openBranches(budget int) {
	n.open = true
	shown, more, _ := n.shownChildren()
	rows := len(shown) + boolRows(more > 0)
	for _, c := range shown {
		c.depth = 1
	}
	frontier := append([]*growthNode{}, shown...)
	tried := map[*growthNode]bool{}
	for {
		best := -1
		for i, c := range frontier {
			kids, _, _ := c.shownChildren()
			if c.open || tried[c] || len(kids) < 2 || c.depth >= 4 {
				continue
			}
			if best < 0 || c.lines > frontier[best].lines {
				best = i
			}
		}
		if best < 0 {
			return
		}
		c := frontier[best]
		kids, more, _ := c.shownChildren()
		cost := len(kids) + boolRows(more > 0)
		if float64(c.lines) < 0.12*float64(n.lines) {
			return // the heaviest left is too light to open; so is every other
		}
		if rows+cost > budget {
			tried[c] = true // a lighter one may still fit
			continue
		}
		c.open, rows = true, rows+cost
		for _, k := range kids {
			k.depth = c.depth + 1
		}
		frontier = append(frontier, kids...)
	}
}

func boolRows(b bool) int {
	if b {
		return 1
	}
	return 0
}

// pathMention is a path the plan names: "src/api/", "internal/core/tools", "cmd/server.go".
var pathMention = regexp.MustCompile(`[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+/?`)

// placeBuds puts each plan item on its branch: the file it was worked on in, else the folder its
// words name (a path, or a branch's own name), deepest first; a path that does not exist yet
// grows a planned branch; the rest stay on the trunk. Buds go on the nearest drawn branch.
func (n *growthNode) placeBuds(plan []growthBud, placed map[int]string) {
	all := map[string]*growthNode{}
	var walk func(x *growthNode)
	walk = func(x *growthNode) {
		all[x.path] = x
		for _, c := range x.children {
			walk(c)
		}
	}
	walk(n)
	for _, b := range plan {
		target := ""
		if file, ok := placed[b.id]; ok {
			target = fileDir(file)
		} else if dir := mentionedDir(b.text, all); dir != "" {
			target = dir
		} else if p := pathMention.FindString(b.text); p != "" {
			// A path the code does not have yet: a planned branch.
			dir := strings.TrimSuffix(p, "/")
			if path.Ext(dir) != "" {
				dir = fileDir(dir)
			}
			if dir != "" {
				target = n.plant(dir, all)
			}
		}
		at := n.drawnAt(target, all)
		at.buds = append(at.buds, b)
	}
}

// mentionedDir is the deepest folder whose path, or whose own name (three letters or more, as a
// word), the text names.
func mentionedDir(text string, all map[string]*growthNode) string {
	lower := strings.ToLower(text)
	best, bestDepth := "", -1
	for p := range all {
		if p == "" {
			continue
		}
		depth := strings.Count(p, "/")
		named := strings.Contains(lower, strings.ToLower(p))
		if !named {
			last := strings.ToLower(path.Base(p))
			named = len(last) >= 3 && wordIn(lower, last)
		}
		if named && (depth > bestDepth || depth == bestDepth && p < best) {
			best, bestDepth = p, depth
		}
	}
	return best
}

func wordIn(text, word string) bool {
	for i := 0; ; {
		at := strings.Index(text[i:], word)
		if at < 0 {
			return false
		}
		at += i
		before := at == 0 || !isWordByte(text[at-1])
		after := at+len(word) == len(text) || !isWordByte(text[at+len(word)])
		if before && after {
			return true
		}
		i = at + 1
	}
}

func isWordByte(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
}

// plant grows a planned branch at dir under its deepest existing folder, and returns its path.
func (n *growthNode) plant(dir string, all map[string]*growthNode) string {
	if _, ok := all[dir]; ok {
		return dir
	}
	parent := parentDir(dir)
	for parent != "" && all[parent] == nil {
		parent = parentDir(parent)
	}
	at := all[parent]
	name := strings.TrimPrefix(strings.TrimPrefix(dir, parent), "/")
	s := &growthNode{name: name, path: dir, seed: true}
	at.children = append(at.children, s)
	all[dir] = s
	return dir
}

// drawnAt is the drawn branch nearest to dir: itself when open or shown, else its ancestors.
func (n *growthNode) drawnAt(dir string, all map[string]*growthNode) *growthNode {
	var chain []*growthNode
	for x := dir; ; x = parentDir(x) {
		if node, ok := all[x]; ok {
			chain = append(chain, node)
		}
		if x == "" {
			break
		}
	}
	// The deepest node whose parent is open is drawn.
	for _, c := range chain {
		if c == n {
			return n
		}
		if p := n.parentOf(c); p != nil && p.open {
			return c
		}
	}
	return n
}

func (n *growthNode) parentOf(target *growthNode) *growthNode {
	for _, c := range n.children {
		if c == target {
			return n
		}
		if p := c.parentOf(target); p != nil {
			return p
		}
	}
	return nil
}

// --- drawing ---

// growthBarWidth is a branch's fill bar, in cells; growthDeltaWidth the column of what this
// session did to it ("+1.2k −40"; a longer one runs into the margin).
const (
	growthBarWidth   = 6
	growthDeltaWidth = 9
)

// maxBudsShown is how many plan items one branch shows before "… n more steps".
const maxBudsShown = 3

// growthRows draws the tree in width columns and at most height rows.
func growthRows(th theme.Theme, n *growthNode, width, height int) []string {
	var rows []string
	add := func(s string) { rows = append(rows, ansi.Truncate(s, width, "…")) }
	biggest := 1
	for _, c := range n.children {
		biggest = max(biggest, c.lines)
	}
	branch := lipgloss.NewStyle().Foreground(th.Tint(th.Secondary, 0.6))
	var draw func(x *growthNode, prefix string)
	draw = func(x *growthNode, prefix string) {
		kids, more, moreLines := x.shownChildren()
		budsShown := min(len(x.buds), maxBudsShown)
		total := len(kids)
		if x.open || x == n {
			total += boolRows(more > 0)
		} else {
			kids, more = nil, 0
		}
		// Buds first, under the branch's name, then the branches.
		stem := prefix
		if x != n {
			stem += "  "
		}
		for i := 0; i < budsShown; i++ {
			add(stem + budMark(th, x.buds[i].status) + " " + budText(th, x.buds[i]))
		}
		if len(x.buds) > maxBudsShown {
			add(stem + th.Faint.Render(fmt.Sprintf("… %d more steps", len(x.buds)-maxBudsShown)))
		}
		for i, c := range kids {
			last := i == len(kids)-1 && more == 0
			elbow, carry := "├─", "│  "
			if last {
				elbow, carry = "└─", "   "
			}
			add(prefix + branch.Render(elbow) + " " + growthRow(th, c, width-ansi.StringWidth(prefix)-3, biggest))
			draw(c, prefix+branch.Render(carry))
		}
		if more > 0 {
			add(prefix + branch.Render("└─") + th.Faint.Render(fmt.Sprintf(" … %d more · %s", more, compactCount(moreLines))))
		}
	}
	draw(n, "")
	if len(rows) > height {
		hidden := len(rows) - height + 1
		rows = append(rows[:height-1], th.Faint.Render(fmt.Sprintf("  … %d more rows", hidden)))
	}
	return rows
}

// growthRow is one branch's line: its name, its fill, its size, and what this session did to it.
func growthRow(th theme.Theme, n *growthNode, width, biggest int) string {
	size := compactCount(n.lines)
	delta := ""
	switch {
	case n.seed:
		size, delta = "", th.Faint.Render("planned")
	case n.removed > n.added && n.removed > 0:
		delta = th.Warn.Render("pruned " + compactCount(n.removed-n.added))
	case n.added > 0 && n.removed == 0:
		delta = th.OK.Render("+" + compactCount(n.added))
	case n.added > 0 || n.removed > 0:
		delta = th.OK.Render("+"+compactCount(n.added)) + th.Faint.Render(" ") + th.Bad.Render("−"+compactCount(n.removed))
	case n.base == 0 && n.lines > 0:
		delta = th.OK.Render("new")
	}
	bar := growthBar(th, n, biggest)
	// The delta has a column of its own, so every bar starts where its neighbours' do.
	tail := " " + bar + " " + th.Faint.Render(fmt.Sprintf("%5s", size))
	switch room := width - ansi.StringWidth(tail); {
	case room-growthDeltaWidth-1 >= 6:
		tail += " " + delta + strings.Repeat(" ", max(growthDeltaWidth-ansi.StringWidth(delta), 0))
	case delta != "" && room-ansi.StringWidth(delta)-1 >= 3:
		tail += " " + delta // narrow: the delta still shows, unaligned
	}
	nameWidth := width - ansi.StringWidth(tail)
	nameStyle := th.Body
	if n.seed {
		nameStyle = th.Faint
	}
	name := fitBranchName(n.name, max(nameWidth, 3))
	return nameStyle.Render(name) + strings.Repeat(" ", max(nameWidth-ansi.StringWidth(name), 0)) + tail
}

// growthBar fills with the branch's share of the biggest one: the code it had in the dim shade,
// the code written this session in the bright one, so a branch visibly fills as it grows.
func growthBar(th theme.Theme, n *growthNode, biggest int) string {
	if n.seed || n.lines == 0 {
		return th.Faint.Render(strings.Repeat("░", growthBarWidth))
	}
	filled := min(max(int(math.Ceil(float64(growthBarWidth)*float64(n.lines)/float64(biggest))), 1), growthBarWidth)
	fresh := 0
	if n.grown() > 0 {
		fresh = min(max(int(math.Round(float64(filled)*float64(n.grown())/float64(n.lines))), 1), filled)
	}
	old := lipgloss.NewStyle().Foreground(th.Tint(th.Primary, 0.55))
	return old.Render(strings.Repeat("█", filled-fresh)) + th.OK.Render(strings.Repeat("▓", fresh)) + th.Faint.Render(strings.Repeat("░", growthBarWidth-filled))
}

func budMark(th theme.Theme, status string) string {
	switch status {
	case "done":
		return th.OK.Render("✓")
	case "in_progress":
		return th.Highlight.Render("◐")
	}
	return th.Faint.Render("○")
}

func budText(th theme.Theme, b growthBud) string {
	switch b.status {
	case "done":
		return th.Faint.Render(b.text)
	case "in_progress":
		return th.Strong.Render(b.text)
	}
	return th.Body.Render(b.text)
}

// compactCount is a line count in four characters or fewer: 840, 3.1k, 12k, 1.2M.
func compactCount(n int) string {
	switch {
	case n < 1000:
		return fmt.Sprint(n)
	case n < 10_000:
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	case n < 1_000_000:
		return fmt.Sprintf("%dk", n/1000)
	}
	return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
}

// fitBranchName cuts a branch's name to width; a joined chain ("core/tools") keeps its end, which is
// the part that tells branches apart.
func fitBranchName(name string, width int) string {
	w := ansi.StringWidth(name)
	if w <= width {
		return name
	}
	if strings.Contains(name, "/") && width > 1 {
		return "…" + ansi.TruncateLeft(name, w-width+1, "")
	}
	return ansi.Truncate(name, width, "…")
}
