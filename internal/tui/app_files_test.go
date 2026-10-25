package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func projectModel(t *testing.T) *Model {
	t.Helper()
	root := t.TempDir()
	for rel, content := range map[string]string{
		"README.md":       "# Project\n\nSome **docs**.",
		"src/app.go":      "package app\n\nfunc Run() int { return 42 }\n",
		"src/util/str.go": "package util\n",
	} {
		path := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(path), 0o755)
		os.WriteFile(path, []byte(content), 0o644)
	}
	m, _ := newTestModel(t)
	m.opts.Cwd = root
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	return m
}

func TestProjectViewListsPreviewsAndMentions(t *testing.T) {
	m := projectModel(t)
	submitCommand(m, "/files")
	f, ok := m.activeWindow().(*filesView)
	if !ok || !f.loaded || f.count != 3 {
		t.Fatalf("window=%T loaded=%v count=%d", m.activeWindow(), ok && f.loaded, f.count)
	}
	s := screen(m)
	if !strings.Contains(s, "src/") || !strings.Contains(s, "README.md") || !strings.Contains(s, "3 files") {
		t.Fatalf("tree:\n%s", s)
	}
	// Directories first: src/, then README.md. Move to README.md and see it previewed.
	for i := 0; i < 5; i++ {
		if e, _ := f.selected(); e.path == "README.md" {
			break
		}
		press(m, tea.KeyDown, 0)
	}
	if e, _ := f.selected(); e.path != "README.md" {
		t.Fatalf("selected %+v", e)
	}
	if !strings.Contains(screen(m), "Some docs.") {
		t.Fatalf("no markdown preview:\n%s", screen(m))
	}
	typeText(m, "@")
	if m.activeWindow() != nil || m.input.value() != "@README.md " {
		t.Fatalf("window=%T input=%q", m.activeWindow(), m.input.value())
	}
}

func TestEnterOpensAFileAndEscapeComesBackToTheTree(t *testing.T) {
	m := projectModel(t)
	submitCommand(m, "/files")
	f := m.activeWindow().(*filesView)
	press(m, tea.KeyEnter, 0) // opens src/
	for i := 0; i < 6; i++ {
		if e, _ := f.selected(); e.path == "src/app.go" {
			break
		}
		press(m, tea.KeyDown, 0)
	}
	press(m, tea.KeyEnter, 0)
	p, ok := m.activeWindow().(*pager)
	if !ok || p.label != "src/app.go" || !strings.Contains(screen(m), "return 42") {
		t.Fatalf("viewer: %T\n%s", m.activeWindow(), screen(m))
	}
	press(m, tea.KeyEscape, 0)
	if !m.bar.on || m.activeWindow() != p {
		t.Fatal("esc steps out to the bars, the reader still open")
	}
	press(m, tea.KeyUp, 0)
	typeText(m, "q")
	if m.activeWindow() != f {
		t.Fatalf("q closes the reader and returns to the tree, got %T", m.activeWindow())
	}
}

func TestCatOpensAFileAndRefusesOneOutsideTheProject(t *testing.T) {
	m := projectModel(t)
	submitCommand(m, "/cat src/util/str.go")
	if p, ok := m.activeWindow().(*pager); !ok || p.label != "src/util/str.go" {
		t.Fatalf("%T", m.activeWindow())
	}
	m.active = 0
	submitCommand(m, "/cat ../../etc/passwd")
	if m.activeWindow() != nil || !strings.Contains(screen(m), "outside the project") {
		t.Fatalf("%T\n%s", m.activeWindow(), screen(m))
	}
}

func TestAtCompletesProjectPaths(t *testing.T) {
	m := projectModel(t)
	typeText(m, "look at @") // the first @ reads the project's files
	run(m, m.listFiles())
	typeText(m, "app")
	if len(m.input.complete) != 1 || m.input.complete[0].path != "src/app.go" {
		t.Fatalf("completions %+v", m.input.complete)
	}
	press(m, tea.KeyTab, 0)
	if m.input.value() != "look at @src/app.go " {
		t.Fatalf("%q", m.input.value())
	}
}

func TestProjectViewAndViewerFitEverySize(t *testing.T) {
	m := projectModel(t)
	submitCommand(m, "/files")
	f := m.activeWindow().(*filesView)
	for _, size := range [][2]int{{100, 30}, {60, 16}, {30, 8}, {14, 3}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		m.openWindow(f)
		assertFits(t, m, "files")
		m.openFile("src/app.go")
		assertFits(t, m, "viewer")
	}
}
