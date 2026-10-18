package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/config"
)

func TestTheTourDrawerShowsTheScenesBesideTheCardAndFolds(t *testing.T) {
	m, dir := firstRunModel(t)
	m.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	s := screen(m)
	// The card keeps its prism and words; the drawer shows the scene in front, full size.
	for _, want := range []string{"Explain what this project does", showcaseScenes[0].name, "●", "▸"} {
		if !strings.Contains(s, want) {
			t.Fatalf("home lacks %q:\n%s", want, s)
		}
	}
	for _, line := range strings.Split(s, "\n") {
		if w := ansi.StringWidth(line); w > 160 {
			t.Fatalf("a %d-wide line", w)
		}
	}

	// A dot jumps to its scene.
	x, y := cellOf(t, m, "▸")
	_ = x
	dots := strings.Index(ansi.Strip(strings.Split(s, "\n")[y]), "○")
	click(m, ansi.StringWidth(ansi.Strip(strings.Split(s, "\n")[y])[:dots]), y)
	if now, _, _, _, _ := m.tourScene(); now == 0 {
		t.Fatal("a click on a dot did not change the scene")
	}

	// ▸ folds it to a tab, remembered; the tab opens it again.
	x, y = cellOf(t, m, "▸")
	click(m, x, y)
	if m.tourOpen || !config.LoadState(dir).TourHidden {
		t.Fatal("▸ should fold the drawer, and remember it")
	}
	s = screen(m)
	if strings.Contains(s, "●") || !strings.Contains(s, " ◂ ") {
		t.Fatalf("folded drawer:\n%s", s)
	}
	x, y = cellOf(t, m, "◂")
	click(m, x, y)
	if !m.tourOpen || config.LoadState(dir).TourHidden {
		t.Fatal("the tab should open the drawer again")
	}
	// alt+o does the same.
	press(m, 'o', tea.ModAlt)
	if m.tourOpen {
		t.Fatal("alt+o should fold it")
	}
}

func TestTheTourDrawerSlidesAndTheScenesTakeTurns(t *testing.T) {
	m, _ := newTestModel(t)
	m.opts.Motion = true
	m.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	if m.tourRight(160, 40) != tourTabWidth {
		t.Fatalf("before any tick the drawer should still be folded: %d", m.tourRight(160, 40))
	}
	widths := []int{}
	for range 25 {
		m.Update(animTickMsg{})
		widths = append(widths, m.tourRight(160, 40))
	}
	full := tourDrawerWidth(160, 40)
	if widths[0] >= full || widths[len(widths)-1] != full {
		t.Fatalf("the drawer should slide out to %d: %v", full, widths)
	}
	// Mid-slide between scenes, both are on screen; then only the new one.
	m.homeT = tourDwell + tourSlideSecs/2
	if _, _, slid, _, _ := m.tourScene(); slid <= 0 || slid >= 1 {
		t.Fatalf("slid = %v", slid)
	}
	if !strings.Contains(screen(m), showcaseScenes[1].name) {
		t.Fatal("the next scene's name is not shown")
	}
	// The card stays usable: never covered by the drawer.
	if !strings.Contains(screen(m), "find anything") {
		t.Fatal(screen(m))
	}
}

func TestTheTourDrawerOnlyWhereTheCardKeepsItsRoom(t *testing.T) {
	m, _ := newTestModel(t)
	for _, size := range [][2]int{{100, 30}, {121, 40}, {160, 16}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		if s := screen(m); strings.Contains(s, "▸") || strings.Contains(s, " ◂ ") {
			t.Fatalf("%dx%d has no room for the drawer:\n%s", size[0], size[1], s)
		}
	}
}
