package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func finderModel(t *testing.T) (*Model, *finder) {
	t.Helper()
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	m.Update(filesLoadedMsg{files: []string{"README.md", "cmd/friday/main.go", "cmd/friday/flags.go", "internal/tui/desk_finder.go"}})
	m.Update(tea.KeyPressMsg{Code: 'g', Mod: tea.ModAlt})
	f, ok := m.activeWindow().(*finder)
	if !ok {
		t.Fatalf("alt+g did not open the Finder: %T", m.overlay)
	}
	return m, f
}

func TestTheFinderShowsPlacesAsIconsAndOpensAnApp(t *testing.T) {
	m, f := finderModel(t)
	s := screen(m)
	for _, want := range []string{"Finder", "Favourites", "Commands", "Sessions", "Files", "Themes", "Chat", "F1", "items"} {
		if !strings.Contains(s, want) {
			t.Fatalf("Finder lacks %q:\n%s", want, s)
		}
	}
	// → and ↓ move in two dimensions.
	press(m, tea.KeyRight, 0)
	if f.grid.cursor != 1 {
		t.Fatalf("→ went to %d", f.grid.cursor)
	}
	press(m, tea.KeyDown, 0)
	if f.grid.cursor != 1+f.grid.cols {
		t.Fatalf("↓ went to %d with %d a row", f.grid.cursor, f.grid.cols)
	}
	// Typing searches everything; enter opens the first match and closes the Finder.
	typeText(m, "stats")
	if f.items[0].name != "Stats" || !strings.Contains(screen(m), "Searching everything") {
		t.Fatalf("search found %q first", f.items[0].name)
	}
	press(m, tea.KeyEnter, 0)
	if m.overlay != nil {
		t.Fatalf("the Finder stayed open: %T", m.overlay)
	}
	if _, ok := m.activeWindow().(*statsApp); !ok {
		t.Fatalf("enter opened %T", m.activeWindow())
	}
}

func TestTheFinderBrowsesFoldersAndComesBackOut(t *testing.T) {
	m, f := finderModel(t)
	// tab into the places, ↓ to Files, → back to the grid.
	press(m, tea.KeyTab, 0)
	for finderPlaces[f.place].id != "files" {
		press(m, tea.KeyDown, 0)
	}
	press(m, tea.KeyRight, 0)
	if f.sidebar || f.items[0].name != "cmd" || f.items[0].note != "2 files" {
		t.Fatalf("Files shows %+v (sidebar %v)", f.items[0], f.sidebar)
	}
	press(m, tea.KeyEnter, 0)
	press(m, tea.KeyEnter, 0)
	if f.dir != "cmd/friday" || !strings.Contains(screen(m), "cmd › friday") {
		t.Fatalf("in %q:\n%s", f.dir, screen(m))
	}
	press(m, tea.KeyBackspace, 0)
	if f.dir != "cmd" || f.items[f.grid.cursor].name != "friday" {
		t.Fatalf("backspace left %q, cursor on %q", f.dir, f.items[f.grid.cursor].name)
	}
	// ← at the grid's left edge goes to the places.
	press(m, tea.KeyLeft, 0)
	if !f.sidebar {
		t.Fatal("← at the edge did not reach the places")
	}
}

func TestQuickLookAndEscStepBack(t *testing.T) {
	m, f := finderModel(t)
	f.choosePlace(m, 1) // Commands
	press(m, tea.KeySpace, 0)
	if !f.looking || !strings.Contains(screen(m), f.items[0].name) {
		t.Fatalf("no quick look:\n%s", screen(m))
	}
	press(m, tea.KeyEscape, 0)
	if _, open := windowOf[*finder](m); f.looking || !open {
		t.Fatal("esc should close the look first")
	}
	typeText(m, "zzzz")
	if !strings.Contains(screen(m), "Nothing matches") {
		t.Fatalf("no empty note:\n%s", screen(m))
	}
	press(m, tea.KeyEscape, 0)
	if _, open := windowOf[*finder](m); f.search.Value() != "" || !open {
		t.Fatal("esc should clear the search next")
	}
	press(m, tea.KeyEscape, 0)
	if _, open := windowOf[*finder](m); !open || !m.bar.on {
		t.Fatal("esc should step out to the bars last, the Finder still open")
	}
}

func TestAClickPicksAPlaceAndASecondClickOpens(t *testing.T) {
	m, f := finderModel(t)
	x, y := cellOf(t, m, "Themes   ")
	click(m, x, y)
	if finderPlaces[f.place].id != "themes" {
		t.Fatalf("clicked into %q", finderPlaces[f.place].id)
	}
	x, y = cellOf(t, m, f.items[1].name)
	click(m, x, y)
	if f.grid.cursor != 1 {
		t.Fatalf("click picked %d", f.grid.cursor)
	}
	name := f.items[1].name
	click(m, x, y)
	if m.overlay != nil || m.th.Name != name {
		t.Fatalf("second click: overlay %T, theme %q", m.overlay, m.th.Name)
	}
}
