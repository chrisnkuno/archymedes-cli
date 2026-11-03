package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestGrowthTreeSumsFoldersAndJoinsSingleChains(t *testing.T) {
	lines := map[string]int{
		"internal/core/tools/a.go": 300, "internal/core/tools/b.go": 100,
		"internal/core/loop/l.go": 200, "internal/tui/v.go": 900, "main.go": 10,
	}
	tree := buildGrowthTree(lines, lines, map[string][2]int{"internal/tui/v.go": {40, 5}, "README.md": {9, 0}})
	if tree.lines != 1510 {
		t.Fatalf("trunk: %d", tree.lines)
	}
	if len(tree.children) != 1 || tree.children[0].name != "internal" {
		t.Fatalf("top: %+v", tree.children)
	}
	internal := tree.children[0]
	if internal.children[0].name != "tui" || internal.children[1].name != "core" || internal.children[1].lines != 600 {
		t.Errorf("heaviest first, sums: %+v %+v", internal.children[0], internal.children[1])
	}
	if tree.added != 40 || tree.removed != 5 {
		t.Errorf("prose edits count as code: +%d −%d", tree.added, tree.removed)
	}
	// A folder holding only one folder is drawn as one branch.
	chain := buildGrowthTree(map[string]int{"src/app/x.ts": 5, "src/app/y.ts": 5}, nil, nil)
	if chain.children[0].name != "src/app" {
		t.Errorf("chain not joined: %q", chain.children[0].name)
	}
}

func TestGrowthOpensWhereTheCodeIsWithinItsRows(t *testing.T) {
	lines := map[string]int{}
	for _, p := range []string{"big/a/x.go", "big/b/x.go", "big/c/x.go"} {
		lines[p] = 1000
	}
	lines["big/own.go"] = 1
	lines["small/a/x.go"], lines["small/b/x.go"] = 10, 10
	tree := buildGrowthTree(lines, lines, nil)
	tree.openBranches(20)
	big, small := tree.children[0], tree.children[1]
	if !big.open || small.open {
		t.Errorf("open: big %v, small %v (small holds under 12%%)", big.open, small.open)
	}
	tight := buildGrowthTree(lines, lines, nil)
	tight.openBranches(3)
	if tight.children[0].open {
		t.Error("opened past the row budget")
	}
}

func TestPlanBudsGrowOnTheirBranches(t *testing.T) {
	lines := map[string]int{"internal/core/tools/a.go": 500, "internal/tui/v.go": 500, "cmd/main.go": 50}
	tree := buildGrowthTree(lines, lines, nil)
	tree.openBranches(30)
	plan := []growthBud{
		{1, "done", "estimate test times in the tools package"},
		{2, "in_progress", "draw it on the card"},
		{3, "pending", "add the API under server/api/handlers.go"},
		{4, "pending", "write the release notes"},
	}
	tree.placeBuds(plan, map[int]string{2: "internal/tui/v.go"})
	find := func(name string) *growthNode {
		var found *growthNode
		var walk func(n *growthNode)
		walk = func(n *growthNode) {
			if n.path == name {
				found = n
			}
			for _, c := range n.children {
				walk(c)
			}
		}
		walk(tree)
		return found
	}
	if n := find("internal/core/tools"); n == nil || len(n.buds) != 1 || n.buds[0].id != 1 {
		t.Errorf("named by its folder: %+v", n)
	}
	if n := find("internal/tui"); n == nil || len(n.buds) != 1 || n.buds[0].id != 2 {
		t.Errorf("placed by the file it was worked in: %+v", n)
	}
	if n := find("server/api"); n == nil || !n.seed || len(n.buds) != 1 {
		t.Errorf("a planned path grows a planned branch: %+v", n)
	}
	if len(tree.buds) != 1 || tree.buds[0].id != 4 {
		t.Errorf("the rest on the trunk: %+v", tree.buds)
	}
	rows := ansi.Strip(strings.Join(growthRows(testTheme(), tree, 40, 40), "\n"))
	for _, want := range []string{"tools", "✓ estimate test times", "◐ draw it on the card", "server/api", "planned", "○ write the release notes"} {
		if !strings.Contains(rows, want) {
			t.Errorf("drawn tree lacks %q:\n%s", want, rows)
		}
	}
}

func TestGrowthRowMarksNewGrownAndPruned(t *testing.T) {
	th := testTheme()
	grown := ansi.Strip(growthRow(th, &growthNode{name: "a", lines: 120, base: 100, added: 25, removed: 5}, 30, 120))
	if !strings.Contains(grown, "+25 −5") || !strings.Contains(grown, "▓") {
		t.Errorf("grown: %q", grown)
	}
	pruned := ansi.Strip(growthRow(th, &growthNode{name: "b", lines: 60, base: 100, added: 5, removed: 45}, 30, 120))
	if !strings.Contains(pruned, "pruned 40") {
		t.Errorf("pruned: %q", pruned)
	}
	fresh := ansi.Strip(growthRow(th, &growthNode{name: "c", lines: 40}, 30, 120))
	if !strings.Contains(fresh, "new") {
		t.Errorf("new: %q", fresh)
	}
	for _, row := range []string{grown, pruned, fresh} {
		if w := ansi.StringWidth(row); w > 30 {
			t.Errorf("%q is %d columns", row, w)
		}
	}
	for n, want := range map[int]string{840: "840", 3140: "3.1k", 12_500: "12k", 1_200_000: "1.2M"} {
		if got := compactCount(n); got != want {
			t.Errorf("%d: %q", n, got)
		}
	}
}

func TestMeasureCountsCodeAndReusesUnchangedCounts(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(root, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.go", "package a\n\nfunc A() {}\n")
	write("README.md", "# hi\nmore\n")
	write("bin.go", "\x00\x01binary")
	first := measureGrowth(root, nil)().(growthMeasuredMsg)
	if first.lines["a.go"] != 2 || first.lines["README.md"] != 0 || first.lines["bin.go"] != 0 {
		t.Fatalf("counted: %v", first.lines)
	}
	// A cached count is trusted while size and time match, and read again when they do not.
	fake := first.cache["a.go"]
	fake.lines = 99
	first.cache["a.go"] = fake
	if again := measureGrowth(root, first.cache)().(growthMeasuredMsg); again.lines["a.go"] != 99 {
		t.Errorf("unchanged file counted again: %v", again.lines)
	}
	write("a.go", "package a\n\nfunc A() {}\nfunc B() {}\n")
	later := time.Now().Add(time.Second)
	_ = os.Chtimes(filepath.Join(root, "a.go"), later, later)
	if changed := measureGrowth(root, first.cache)().(growthMeasuredMsg); changed.lines["a.go"] != 3 {
		t.Errorf("changed file not counted again: %v", changed.lines)
	}
}

// The panel end to end: alt+v shows it, it measures, the plan and an edit land on it, and on a
// wide terminal it stands beside the changes rail without a row running over.
func TestGrowthPanelGrowsWithTheWork(t *testing.T) {
	m, _ := newTestModel(t)
	root := t.TempDir()
	m.opts.Cwd = root
	if err := os.MkdirAll(filepath.Join(root, "pkg", "store"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "pkg", "store", "db.go"), []byte("package store\n\nvar X = 1\n"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "pkg", "web.go"), []byte("package pkg\n"), 0o644)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	m.tr.add(&noticeItem{kind: noticeInfo, text: "conversation"}) // past the landing screen
	deliver(m, press(m, 'v', tea.ModAlt))
	if !m.growth.shown || !m.growth.measured {
		t.Fatalf("alt+v: shown %v measured %v", m.growth.shown, m.growth.measured)
	}
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "p1", ToolName: "todo_write", Arguments: map[string]any{}})
	m.handleRuntime(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "p1", ToolName: "todo_write",
		Content: "[x] 1. read the store\n[~] 2. cache queries\n[ ] 3. add api/routes.go"})
	m.growthEdit(filepath.Join(root, "pkg", "store", "db.go"), 12, 3)
	s := screen(m)
	for _, want := range []string{"Growth", "this session +12 −3", "plan", "1/3 steps", "store", "◐ cache queries", "api", "planned"} {
		if !strings.Contains(s, want) {
			t.Errorf("panel lacks %q:\n%s", want, s)
		}
	}
	if m.growth.placed[2] != "pkg/store/db.go" {
		t.Errorf("the step in progress was not placed on the edited file: %v", m.growth.placed)
	}
	for _, width := range []int{96, 120, 170} {
		m.Update(tea.WindowSizeMsg{Width: width, Height: 30})
		for i, row := range strings.Split(m.View().Content, "\n") {
			if w := ansi.StringWidth(row); w > width {
				t.Errorf("width %d: row %d is %d columns", width, i, w)
			}
		}
	}
	cmd, ok := m.runCommand("/growth")
	if !ok {
		t.Fatal("/growth is not a command")
	}
	deliver(m, cmd)
	if m.growth.shown || m.growthWidth() != 0 {
		t.Error("/growth did not hide it")
	}
}
