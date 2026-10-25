package tui

import (
	"testing"
)

func TestAListMovesSkipsHeadersAndPages(t *testing.T) {
	headers := map[int]bool{0: true, 4: true}
	l := listView{skip: func(i int) bool { return headers[i] }}
	l.window(10, 3)
	l.move("home", 10)
	if l.cursor != 1 {
		t.Fatalf("home landed on %d, not the first row past the header", l.cursor)
	}
	for range 3 {
		l.move("down", 10)
	}
	if l.cursor != 5 {
		t.Fatalf("down went to %d; it should step over the header at 4", l.cursor)
	}
	l.move("end", 10)
	l.move("down", 10)
	if l.cursor != 9 {
		t.Fatalf("down at the end moved to %d without wrap", l.cursor)
	}
	l.move("pgup", 10)
	if l.cursor != 7 {
		t.Fatalf("pgup moved to %d; a page is the rows shown less one", l.cursor)
	}
	if from, to := l.window(10, 3); from > l.cursor || to <= l.cursor {
		t.Fatalf("cursor %d out of view %d..%d", l.cursor, from, to)
	}
	w := listView{wrap: true}
	w.move("up", 3)
	if w.cursor != 2 {
		t.Fatalf("a wrapping list went from the top to %d", w.cursor)
	}
}

func TestTheWheelScrollsAndTheSelectionFollowsOnlyToStayInView(t *testing.T) {
	l := listView{}
	l.window(20, 5)
	l.wheel(false, 20)
	if l.top != 3 || l.cursor != 3 {
		t.Fatalf("top=%d cursor=%d after a notch down", l.top, l.cursor)
	}
	l.cursor = 6
	l.wheel(false, 20)
	if l.top != 6 || l.cursor != 6 {
		t.Fatalf("a selection still in view moved: top=%d cursor=%d", l.top, l.cursor)
	}
	for range 10 {
		l.wheel(false, 20)
	}
	if l.top != 15 {
		t.Fatalf("scrolled past the end: top=%d", l.top)
	}
}

func TestAClickSelectsAndASecondOpens(t *testing.T) {
	l := listView{}
	if l.clickRow(3) || l.cursor != 3 {
		t.Fatal("the first click should only select")
	}
	if !l.clickRow(3) {
		t.Fatal("a click on the selected row should open it")
	}
	g := tileGrid{tiles: make([]tile, 4)}
	if g.clickTile(2) || !g.clickTile(2) {
		t.Fatal("tiles: select, then open")
	}
}
