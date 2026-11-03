package tui

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// The row writer's output is the canvas's own Render, byte for byte, on every row of every screen
// over the photo, and on rows of every kind of styling a row can hold.
func TestRowWriterMatchesTheCanvas(t *testing.T) {
	styled := []string{
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#ff8800")).Render("bold orange") + " plain " +
			lipgloss.NewStyle().Underline(true).Render("under") + "  " + lipgloss.NewStyle().Italic(true).Faint(true).Render("it"),
		ansi.SetHyperlink("https://example.com") + "a link" + ansi.ResetHyperlink() + " after the link",
		lipgloss.NewStyle().Foreground(lipgloss.Color("208")).Background(lipgloss.Color("4")).Render("256 on basic") + " 日本語 wide",
		lipgloss.NewStyle().Reverse(true).Render("reversed") + "   " + lipgloss.NewStyle().Strikethrough(true).Render("struck"),
		"",
		"    leading spaces then text      ",
	}
	checked := 0
	for name, setup := range wallpaperScreens {
		for _, size := range [][2]int{{120, 36}, {83, 24}} {
			m := wallpaperModel(t, size[0], size[1])
			setup(m)
			m.View() // sets the glass and the panes as the screen has them
			g := m.wallpaper(m.width, m.height)
			if g == nil {
				t.Skip("no wallpaper")
			}
			g.ensureGlyphBg(toRGBA(m.th.Bg))
			rows := append(benchFrame(m), styled...)
			for y, line := range rows {
				y := y % m.height
				for _, panel := range []bool{false, true} {
					canvas := m.composeRow(g, line, y, m.width, panel)
					want := strings.TrimRight(canvas.Render(), "\n")
					if got := renderRow(canvas, m.width); got != want {
						t.Fatalf("%s %v row %d (panel %v):\n got %q\nwant %q", name, size, y, panel, got, want)
					}
					checked++
				}
			}
		}
	}
	if checked < 500 {
		t.Errorf("only %d rows checked", checked)
	}
}
