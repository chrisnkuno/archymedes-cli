package tui

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// allWindows are every app window, as values; TestConformEveryWindowTakesTheWheel finds any missing.
var allWindows = map[string]window{
	"changesApp": (*changesApp)(nil), "filesView": (*filesView)(nil), "finder": (*finder)(nil),
	"galleryApp": (*galleryApp)(nil), "keysApp": (*keysApp)(nil), "modelPicker": (*modelPicker)(nil),
	"notesApp": (*notesApp)(nil), "pager": (*pager)(nil), "providersApp": (*providersApp)(nil),
	"resumePicker": (*resumePicker)(nil), "settingsApp": (*settingsApp)(nil), "showcaseApp": (*showcaseApp)(nil),
	"statsApp": (*statsApp)(nil), "tasksApp": (*tasksApp)(nil), "themePicker": (*themePicker)(nil),
	"wallpaperPicker": (*wallpaperPicker)(nil),
}

// TestConformEveryWindowTakesTheWheel: the wheel scrolls what is under the pointer, so every
// window answers it (docs/mechanisms/README.md, section 10). The list above is checked against
// the source: a type with a title() is a window, and must be in it.
func TestConformEveryWindowTakesTheWheel(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	fset := token.NewFileSet()
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		f, err := parser.ParseFile(fset, file, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range f.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Recv == nil || fn.Name.Name != "title" {
				continue
			}
			recv := fn.Recv.List[0].Type
			if star, ok := recv.(*ast.StarExpr); ok {
				recv = star.X
			}
			if name := recv.(*ast.Ident).Name; allWindows[name] == nil {
				t.Errorf("%s has a title, so it is a window: add it to allWindows", name)
			}
		}
	}
	for name, w := range allWindows {
		_, wheel := w.(wheeler)
		_, at := w.(pointWheeler)
		if !wheel && !at {
			t.Errorf("window %s does not take the wheel", name)
		}
	}
}

func TestAWindowFloatsWithAMarginAndZooms(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	m.runAction("keys")
	r := m.windowRect()
	if r.Min.X < windowMarginX || r.Max.X > 120-windowMarginX || r.Min.Y != 1+windowMarginY {
		t.Fatalf("not floating with a margin: %v", r)
	}
	if s := screen(m); !strings.Contains(s, "╭─ Keys") || !strings.Contains(s, "✕") {
		t.Fatalf("no title bar:\n%s", s)
	}
	x, y := cellOf(t, m, "▢")
	click(m, x, y)
	if !m.zoomed || m.windowRect().Min.X != 0 {
		t.Fatal("▢ should zoom the window to the space between the bars")
	}
	x, y = cellOf(t, m, "✕")
	click(m, x, y)
	if m.activeWindow() != nil {
		t.Fatal("✕ should close the window")
	}
}
