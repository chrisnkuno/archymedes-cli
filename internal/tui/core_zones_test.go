package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func mouseAt(x, y int) tea.MouseClickMsg { return tea.MouseClickMsg{X: x, Y: y, Button: tea.MouseLeft} }

func TestZonesAreWhereTheyAreDrawn(t *testing.T) {
	z := newZoneManager()
	link := ansi.SetHyperlink("https://example.com/a/long/path") + "credit" + ansi.ResetHyperlink()
	frame := "top row\n" + link + " " + z.Mark("after", "\x1b[1mtarget\x1b[0m") + "\n" +
		z.Mark("block", "one\ntwo-two") + "\nwide 日本 " + z.Mark("cjk", "x")
	out := scan(z, frame)
	if strings.Contains(out, "z\x1b") || strings.Count(out, "\x1b[") != strings.Count(frame, "\x1b[")-6 {
		t.Fatalf("markers left in: %q", out)
	}
	if ansi.Strip(out) != "top row\ncredit target\none\ntwo-two\nwide 日本 x" {
		t.Fatalf("text changed: %q", ansi.Strip(out))
	}
	after := z.Get("after")
	if after == nil || after.StartX != 7 || after.EndX != 12 || after.StartY != 1 || after.EndY != 1 {
		t.Errorf("after a link: %+v", after)
	}
	if b := z.Get("block"); b == nil || b.StartY != 2 || b.EndY != 3 || b.StartX != 0 || b.EndX != 6 {
		t.Errorf("two-line zone: %+v", b)
	}
	if c := z.Get("cjk"); c == nil || c.StartX != 10 || c.EndX != 10 {
		t.Errorf("after wide characters: %+v", c)
	}
	if !after.InBounds(mouseAt(9, 1)) || after.InBounds(mouseAt(13, 1)) || after.InBounds(mouseAt(9, 0)) {
		t.Error("InBounds")
	}
	if x, y := after.Pos(mouseAt(9, 1)); x != 2 || y != 0 {
		t.Errorf("Pos: %d,%d", x, y)
	}

	// The next scan replaces the last: a zone not drawn again is gone.
	scan(z, "nothing marked")
	if z.Get("after") != nil || (*zoneInfo)(nil).InBounds(mouseAt(0, 0)) {
		t.Error("a zone outlived the frame it was drawn in")
	}
}

func TestZonesScannedAtAnOffset(t *testing.T) {
	z := newZoneManager()
	out := scanAt(z, "ab"+z.Mark("btn", "OK")+"\n"+z.Mark("row", "second"), 10, 5)
	if out != "abOK\nsecond" {
		t.Fatalf("block: %q", out)
	}
	if b := z.Get("btn"); b.StartX != 12 || b.EndX != 13 || b.StartY != 5 {
		t.Errorf("btn: %+v", b)
	}
	if r := z.Get("row"); r.StartX != 10 || r.StartY != 6 {
		t.Errorf("row: %+v", r)
	}
}

func TestMarkersOfOneManagerAreNotAnothers(t *testing.T) {
	a, b := newZoneManager(), newZoneManager()
	text := a.Mark("x", "A") + b.Mark("x", "B")
	out := scan(a, text)
	if out != "AB" {
		t.Fatalf("every marker is stripped: %q", out)
	}
	if z := a.Get("x"); z == nil || z.StartX != 0 || z.EndX != 0 {
		t.Errorf("a's zone: %+v", z)
	}
	if b.Get("x") != nil {
		t.Error("b recorded a zone it did not scan")
	}
	// A colour code is not a marker.
	if out := scan(a, "\x1b[31mred\x1b[0m"); out != "\x1b[31mred\x1b[0m" {
		t.Errorf("colour stripped: %q", out)
	}
}

// A long frame with many targets is scanned in one pass: its cost grows with its length, not with
// length times targets.
func BenchmarkScanFrame(b *testing.B) {
	z := newZoneManager()
	var sb strings.Builder
	for i := range 200 {
		sb.WriteString(strings.Repeat("\x1b[38;2;10;20;30mword\x1b[0m ", 12))
		sb.WriteString(z.Mark("t"+string(rune('a'+i%26))+strings.Repeat("x", i/26), "target"))
		sb.WriteByte('\n')
	}
	frame := sb.String()
	b.ResetTimer()
	for range b.N {
		scan(z, frame)
	}
}
