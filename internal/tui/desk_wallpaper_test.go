package tui

import (
	"image"
	"image/color"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// The wallpaper's invariants, held on every screen the desktop can show at every size: it covers
// every cell, it never changes a word or a link, and it goes away when asked.

// cells is a frame as its cell grid.
func cells(content string, width, height int) *lipgloss.Canvas {
	c := lipgloss.NewCanvas(width, height)
	c.Compose(lipgloss.NewLayer(content))
	return c
}

// wallpaperModel is a desktop with the wallpaper on, at width×height.
func wallpaperModel(t *testing.T, width, height int) *Model {
	t.Helper()
	m := projectModel(t)
	m.opts.NoWallpaper = false
	m.Update(tea.WindowSizeMsg{Width: width, Height: height})
	return m
}

// screens are the states worth checking, each set up from a fresh home screen.
var wallpaperScreens = map[string]func(m *Model){
	"home": func(*Model) {},
	"conversation": func(m *Model) {
		m.tr.items = append(m.tr.items, &userItem{text: "explain this project"})
	},
	"start menu": func(m *Model) { run(m, m.runAction("start")) },
	"help":       func(m *Model) { run(m, m.runAction("help")) },
	"files":      func(m *Model) { run(m, m.runAction("files")) },
	"keys":       func(m *Model) { run(m, m.runAction("keys")) },
	"stats":      func(m *Model) { run(m, m.runAction("stats")) },
	"settings":   func(m *Model) { run(m, m.runAction("settings")) },
	"providers":  func(m *Model) { run(m, m.runAction("providers")) },
	"toast":      func(m *Model) { m.toast(toastInfo, "saved") },
}

var wallpaperSizes = [][2]int{{200, 60}, {130, 34}, {80, 24}, {50, 16}, {30, 8}}

func TestTheWallpaperCoversEveryCellOfEveryScreen(t *testing.T) {
	for name, setup := range wallpaperScreens {
		for _, size := range wallpaperSizes {
			m := wallpaperModel(t, size[0], size[1])
			setup(m)
			grid := cells(m.View().Content, m.width, m.height)
			for y := range m.height {
				for x := range m.width {
					c := grid.CellAt(x, y)
					if c != nil && c.Width > 0 && c.Style.Bg == nil {
						t.Fatalf("%s at %dx%d: cell (%d,%d) %q has no background: the wallpaper does not reach it", name, size[0], size[1], x, y, c.Content)
					}
				}
			}
			assertFits(t, m, name+" with wallpaper")
		}
	}
}

func TestTheWallpaperNeverChangesAWordOrALink(t *testing.T) {
	for name, setup := range wallpaperScreens {
		for _, size := range wallpaperSizes {
			m := wallpaperModel(t, size[0], size[1])
			setup(m)
			var with, without *lipgloss.Canvas
			for {
				// The top bar's clock is the real time: render the pair again if the minute turned between them.
				minute := time.Now().Format("15:04")
				m.opts.NoWallpaper = false
				with = cells(m.View().Content, m.width, m.height)
				m.opts.NoWallpaper = true
				without = cells(m.View().Content, m.width, m.height)
				if time.Now().Format("15:04") == minute {
					break
				}
			}
			for y := range m.height {
				for x := range m.width {
					a, b := without.CellAt(x, y), with.CellAt(x, y)
					if a == nil || b == nil || a.Width == 0 {
						continue // the second column of a wide glyph holds nothing of its own
					}
					blank := a.Content == " " || a.Content == ""
					if !blank && a.Content != b.Content {
						t.Fatalf("%s at %dx%d: (%d,%d) was %q, is %q under the wallpaper", name, size[0], size[1], x, y, a.Content, b.Content)
					}
					if blank && b.Content != "▀" && b.Style.Bg == nil {
						t.Fatalf("%s at %dx%d: empty (%d,%d) shows %q, neither the photo nor glass", name, size[0], size[1], x, y, b.Content)
					}
					if a.Link.URL != b.Link.URL {
						t.Fatalf("%s at %dx%d: (%d,%d) lost its link %q", name, size[0], size[1], x, y, a.Link.URL)
					}
				}
			}
		}
	}
}

func TestTheChromeIsFrostedGlassAndTheRestShowsThePhoto(t *testing.T) {
	m := wallpaperModel(t, 130, 34)
	grid := cells(m.View().Content, m.width, m.height)
	panels := m.panelRows(m.height)
	photoCells := 0
	for y := range m.height {
		for x := range m.width {
			c := grid.CellAt(x, y)
			if c == nil || c.Width == 0 {
				continue
			}
			if panels[y] && c.Content == "▀" {
				t.Fatalf("row %d is chrome, but (%d,%d) shows the photo through it", y, x, y)
			}
			if !panels[y] && c.Content == "▀" {
				photoCells++
			}
		}
	}
	// The card covers the middle; most of what is around it is the photo.
	if photoCells < m.width*(m.height-len(panels))/3 {
		t.Fatalf("only %d cells show the photo", photoCells)
	}
}

func TestEveryGlyphOverThePhotoSitsOnGlass(t *testing.T) {
	m := wallpaperModel(t, 130, 34)
	m.tr.items = append(m.tr.items, &userItem{text: "explain this project"})
	grid := cells(m.View().Content, m.width, m.height)
	ground := toRGBA(m.th.Bg)
	g := m.wallpaper(m.width, m.height)
	for y := range m.height {
		for x := range m.width {
			c := grid.CellAt(x, y)
			if c == nil || c.Width == 0 || c.Content == "▀" || c.Content == " " {
				continue
			}
			top, bottom := g.at(x, y)
			if want := mixRGBA(ground, mixRGBA(top, bottom, 0.5), 1-glassMix); toRGBA(c.Style.Bg) != want && c.Style.Bg == nil {
				t.Fatalf("(%d,%d) %q has no glass behind it", x, y, c.Content)
			}
		}
	}
}

func TestTheWallpaperIsQuieterBehindAConversationThanOnTheHomeScreen(t *testing.T) {
	m := wallpaperModel(t, 130, 34)
	home := m.wallpaper(130, 34)
	m.tr.items = append(m.tr.items, &userItem{text: "hi"})
	work := m.wallpaper(130, 34)
	if home == work {
		t.Fatal("the same grid behind a conversation as on the home screen")
	}
	ground := toRGBA(m.th.Bg)
	if distance(work, ground) >= distance(home, ground) {
		t.Fatal("the wallpaper is not dimmer behind a conversation")
	}
}

// distance is how far a grid's colours sit from ground, summed.
func distance(g *wallpaperGrid, ground color.RGBA) int {
	total := 0
	abs := func(a, b uint8) int {
		if a > b {
			return int(a - b)
		}
		return int(b - a)
	}
	for _, c := range append(append([]color.RGBA{}, g.top...), g.bottom...) {
		total += abs(c.R, ground.R) + abs(c.G, ground.G) + abs(c.B, ground.B)
	}
	return total
}

func TestTheWallpaperIsBuiltOnceAndRebuiltOnlyWhenSomethingChanges(t *testing.T) {
	m := wallpaperModel(t, 130, 34)
	a := m.wallpaper(130, 34)
	m.View()
	if m.wallpaper(130, 34) != a {
		t.Fatal("rebuilt for an unchanged frame")
	}
	if m.wallpaper(120, 34) == a {
		t.Fatal("kept across a resize")
	}
	m.photoIndex++
	if b := m.wallpaper(120, 34); b == nil || b == a {
		t.Fatal("not rebuilt when the photo turned")
	}
}

func TestAnUnchangedFrameReusesItsWallpaperAndAChangedOneDoesNot(t *testing.T) {
	m := wallpaperModel(t, 130, 34)
	a := m.View().Content
	if m.underIn == "" || m.View().Content != a {
		t.Fatal("an unchanged frame was not reused")
	}
	m.input.area.InsertString("hello")
	if b := m.View().Content; b == a || !strings.Contains(ansi.Strip(b), "hello") {
		t.Fatal("a changed frame showed the old one")
	}
}

// photoShown: the screen s has the wallpaper on it. A photo fills hundreds of cells with half
// blocks; the desktop's icons draw their edges with a few dozen.
func photoShown(s string) bool { return strings.Count(s, "▀")+strings.Count(s, "▄") > 400 }

func TestTheWallpaperGoesAwayWhenAsked(t *testing.T) {
	for _, off := range []func(m *Model){
		func(m *Model) { m.opts.NoWallpaper = true },
		func(m *Model) { m.opts.NoPhotos = true },
	} {
		m := wallpaperModel(t, 130, 34)
		off(m)
		if photoShown(screen(m)) || m.wallpaper(130, 34) != nil {
			t.Fatal("the wallpaper is drawn although it was turned off")
		}
	}
}

func TestBuildWallpaperCoversTheGridWithoutStretching(t *testing.T) {
	// A wide red-left, blue-right photo on a tall screen: cover crops the sides, keeping the middle,
	// so both halves of the screen are a mix, never one solid colour stretched across.
	img := image.NewRGBA(image.Rect(0, 0, 400, 100))
	for y := range 100 {
		for x := range 400 {
			c := color.RGBA{255, 0, 0, 255}
			if x >= 200 {
				c = color.RGBA{0, 0, 255, 255}
			}
			img.SetRGBA(x, y, c)
		}
	}
	g := buildWallpaper(img, 10, 10, 1, color.Black)
	if len(g.top) != 100 || len(g.bottom) != 100 {
		t.Fatalf("grid of %d cells", len(g.top))
	}
	left, right := g.top[5*10+0], g.top[5*10+9]
	if left.R < 200 || right.B < 200 {
		t.Fatalf("the centre of the photo is not what fills the grid: left %v right %v", left, right)
	}
	// Dimmed all the way, it is the ground.
	if dark := buildWallpaper(img, 4, 4, 0, color.Black); dark.top[0] != (color.RGBA{0, 0, 0, 255}) {
		t.Fatalf("keep 0 is not the ground: %v", dark.top[0])
	}
}

func TestMixRGBAStaysBetweenItsEnds(t *testing.T) {
	a, b := color.RGBA{200, 10, 100, 255}, color.RGBA{0, 250, 100, 255}
	for _, keep := range []float64{0, 0.16, 0.5, 0.84, 1} {
		c := mixRGBA(a, b, keep)
		for _, ch := range [][3]uint8{{c.R, a.R, b.R}, {c.G, a.G, b.G}, {c.B, a.B, b.B}} {
			lo, hi := min(ch[1], ch[2]), max(ch[1], ch[2])
			if ch[0] < lo || ch[0] > hi {
				t.Fatalf("mix %v at %.2f left its ends: %v", c, keep, ch)
			}
		}
	}
	if mixRGBA(a, b, 1) != a || mixRGBA(a, b, 0) != b {
		t.Fatal("the ends are not the ends")
	}
}
