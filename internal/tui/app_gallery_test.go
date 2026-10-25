package tui

import (
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/NimbleMarkets/ntcharts/v2/picture"
	"github.com/NimbleMarkets/ntcharts/v2/picture/pictureurl"
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/gallery"
)

// photoServer stands in for Unsplash's CDN: a small JPEG for every path, and who asked.
func photoServer(t *testing.T, agents *[]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*agents = append(*agents, r.UserAgent())
		img := image.NewRGBA(image.Rect(0, 0, 64, 48))
		for x := range 64 {
			for y := range 48 {
				img.Set(x, y, color.RGBA{uint8(x * 4), uint8(y * 5), 120, 255})
			}
		}
		w.Header().Set("Content-Type", "image/jpeg")
		jpeg.Encode(w, img, nil)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// openGalleryWith opens the Gallery with its live pane fetching from srv, and delivers the fetch.
func openGalleryWith(t *testing.T, m *Model, srv *httptest.Server) *galleryApp {
	t.Helper()
	cmd := m.openGallery(0)
	g := m.galleryWindow()
	if g == nil {
		t.Fatal("no Gallery window")
	}
	if srv != nil {
		g.source = func(p gallery.Photo) string { return srv.URL + "/" + p.ID }
		cmd = g.show(m, 0)
	}
	deliver(m, cmd)
	return g
}

func TestTheGalleryShowsTheBuiltInPhotoBesideTheLiveOneWithCaptions(t *testing.T) {
	m := projectModel(t)
	m.opts.Version = "3.1.0"
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	var agents []string
	g := openGalleryWith(t, m, photoServer(t, &agents))
	if g.live.State() != pictureurl.StateLoaded {
		t.Fatalf("live photo state %v, err %v", g.live.State(), g.live.Err())
	}
	if len(agents) == 0 || !strings.HasPrefix(agents[0], "friday/3.1.0") {
		t.Fatalf("fetched without saying who asks: %q", agents)
	}
	s := screen(m)
	for _, want := range []string{"Gallery", fmt.Sprintf("1 of %d", len(gallery.Photos)), "built into Friday", "live from Unsplash", gallery.Pick(0).Title, "by " + gallery.Pick(0).By, "fit contain", "←/→ picture", "↑/↓ theme", "Kitty:", "Sixel:"} {
		if !strings.Contains(s, want) {
			t.Fatalf("Gallery lacks %q:\n%s", want, s)
		}
	}
	if strings.Count(s, "▀")+strings.Count(s, "▄") < 200 {
		t.Fatalf("two pictures are not drawn:\n%s", s)
	}
}

func TestTheGalleryTurnsChangesFitAndCloses(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	var agents []string
	g := openGalleryWith(t, m, photoServer(t, &agents))
	deliver(m, press(m, tea.KeyRight, 0))
	if g.index != 1 || !strings.Contains(screen(m), gallery.Pick(1).Title) {
		t.Fatal("→ did not show the next photo")
	}
	deliver(m, press(m, tea.KeyLeft, 0))
	deliver(m, press(m, tea.KeyLeft, 0))
	if g.index != len(gallery.Photos)-1 {
		t.Fatalf("← from the first wraps to the last: %d", g.index)
	}
	press(m, tea.KeyDown, 0) // from the last picture: the first of the next theme, wrapping
	if g.index != 0 {
		t.Fatalf("↓ from the last picture should wrap to the first theme: %d", g.index)
	}
	deliver(m, press(m, tea.KeyDown, 0))
	if gallery.Pick(g.index).Theme == gallery.Pick(0).Theme || gallery.Pick(g.index-1).Theme != gallery.Pick(0).Theme {
		t.Fatalf("↓ should land on the next theme's first picture: %d", g.index)
	}
	deliver(m, press(m, tea.KeyUp, 0))
	if g.index != 0 {
		t.Fatalf("↑ from a theme's first picture goes to the theme before: %d", g.index)
	}
	typeText(m, "f")
	if g.builtIn.Fit() != picture.FitCover || g.live.Fit() != picture.FitCover || !strings.Contains(screen(m), "fit cover") {
		t.Fatal("f did not change both pictures' fit")
	}
	typeText(m, "g") // this terminal has no Kitty graphics: said, not attempted
	if g.builtIn.Mode() != picture.PictureGlyph {
		t.Fatal("switched to Kitty on a terminal without it")
	}
	press(m, tea.KeyEscape, 0)
	if m.galleryWindow() != nil {
		t.Fatal("esc did not close the Gallery")
	}
}

func TestTheGallerySaysWhenThePhotoCannotBeFetchedAndKeepsTheBuiltInCopy(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "gone", http.StatusNotFound) }))
	defer srv.Close()
	openGalleryWith(t, m, srv)
	s := screen(m)
	if !strings.Contains(s, "Could not load it") || !strings.Contains(s, "built into Friday") {
		t.Fatalf("a failed fetch:\n%s", s)
	}
}

func TestTheGalleryStaysOfflineWhenAsked(t *testing.T) {
	m := projectModel(t)
	m.opts.PhotosOffline = true
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	g := openGalleryWith(t, m, nil)
	if g.live.State() != pictureurl.StateEmpty || strings.Contains(screen(m), "live from Unsplash") {
		t.Fatal("fetched with ARCHYMEDES_PHOTOS=local")
	}
}

func TestTheGalleryFitsEverySize(t *testing.T) {
	m := projectModel(t)
	var agents []string
	openGalleryWith(t, m, photoServer(t, &agents))
	for _, size := range [][2]int{{200, 60}, {130, 34}, {100, 30}, {80, 24}, {50, 16}, {30, 8}, {14, 4}} {
		deliver(m, func() tea.Msg { return tea.WindowSizeMsg{Width: size[0], Height: size[1]} })
		assertFits(t, m, "gallery")
	}
}

// rawOutput runs cmd (and its batch) and returns every raw sequence it would write, and whether it
// clears the screen; ticks are delivered at once rather than waited for.
func sixelOutput(t *testing.T, m *Model, cmd tea.Cmd) (raw string, cleared bool) {
	t.Helper()
	var walk func(tea.Cmd)
	walk = func(c tea.Cmd) {
		if c == nil {
			return
		}
		switch msg := c().(type) {
		case tea.BatchMsg:
			for _, sub := range msg {
				walk(sub)
			}
		case tea.RawMsg:
			raw += fmt.Sprint(msg.Msg)
		case sixelDrawMsg:
			_, next := m.Update(msg)
			walk(next)
		default:
			if fmt.Sprintf("%T", msg) == "tea.clearScreenMsg" {
				cleared = true
			}
		}
	}
	walk(cmd)
	return raw, cleared
}

func TestTheGalleryDrawsInSixelWhereTheTerminalCanAndOnlyThere(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	var agents []string
	g := openGalleryWith(t, m, photoServer(t, &agents))
	if g.mode != modeGlyph {
		t.Fatalf("started in %v before the terminal said what it draws", g.mode)
	}
	// Windows Terminal's answer to DA1 includes 4: Sixel. And its window is 1170×680 pixels.
	m.Update(uv.PixelSizeEvent{Width: 1170, Height: 680})
	_, cmd := m.Update(uv.PrimaryDeviceAttributesEvent{61, 4, 6, 7, 14, 21, 22, 23, 24, 28, 32, 42})
	if !g.sixel || g.mode != modeSixel {
		t.Fatalf("sixel=%v mode=%v", g.sixel, g.mode)
	}
	if w, h := m.cellPixels(); w != 9 || h != 20 {
		t.Fatalf("cell %d×%d from the window's pixels", w, h)
	}
	// The picture cells are blank in the frame; the image is written over them.
	if s := screen(m); strings.Count(s, "▄")+strings.Count(s, "▀") > 0 || !strings.Contains(s, "drawn as Sixel") || !strings.Contains(s, "Sixel: yes") {
		t.Fatalf("sixel frame:\n%s", s)
	}
	raw, _ := sixelOutput(t, m, cmd)
	if strings.Count(raw, "\x1bP0;1q") != 2 || !strings.HasPrefix(raw, ansi.SaveCursor) || !strings.HasSuffix(raw, ansi.RestoreCursor) {
		t.Fatalf("two sixel pictures between a saved and restored cursor; got %d bytes", len(raw))
	}
	l := g.layout(m)
	if !strings.Contains(raw, ansi.CursorPosition(2, 5)) || !strings.Contains(raw, ansi.CursorPosition(l.paneWidth+3, 5)) {
		t.Fatal("not placed at the panes' picture cells")
	}
	// Nothing changed: not drawn again.
	if _, again := m.Update(tea.KeyPressMsg{Code: 'x', Text: "x"}); again != nil {
		if raw, _ := sixelOutput(t, m, again); raw != "" {
			t.Fatal("drawn again with nothing changed")
		}
	}
	// The next photo is drawn over the last; leaving the Gallery clears the screen.
	_, cmd = m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	if raw, _ := sixelOutput(t, m, cmd); !strings.Contains(raw, "\x1bP0;1q") {
		t.Fatal("the next photo was not drawn")
	}
	_, cmd = m.Update(fkey(1))
	if _, cleared := sixelOutput(t, m, cmd); !cleared {
		t.Fatal("left a picture on screen after leaving the Gallery")
	}
}

func TestGCyclesThroughWhatTheTerminalDraws(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	g := openGalleryWith(t, m, nil)
	m.Update(uv.PrimaryDeviceAttributesEvent{62, 4})
	typeText(m, "g")
	if g.mode != modeGlyph || !g.chosen {
		t.Fatalf("g from Sixel goes back to glyphs: %v", g.mode)
	}
	typeText(m, "g")
	if g.mode != modeSixel {
		t.Fatalf("and on to Sixel: %v", g.mode)
	}
	m.Update(uv.PrimaryDeviceAttributesEvent{62, 4}) // a second answer does not undo a choice
	if g.mode != modeSixel {
		t.Fatal("a choice was overridden")
	}
}

func TestASixelPictureFillsItsCellsAndNeverSpillsBelow(t *testing.T) {
	m := projectModel(t)
	m.cellW, m.cellH = 10, 21
	img, _ := gallery.Pick(0).Image()
	out := m.sixelPicture(img, 20, 7, picture.FitContain)
	// Raster attributes: "1;1;width;height — 200 wide, and 147 high rounded down to whole 6-pixel bands.
	if !strings.Contains(out, `"1;1;200;144`) {
		t.Fatalf("raster attributes: %q", out[:min(len(out), 40)])
	}
	for _, fit := range []picture.FitMode{picture.FitContain, picture.FitCover, picture.FitFill} {
		r := fitRect(300, 100, 200, 144, fit)
		if r.Dx() > 200 && fit == picture.FitContain || (fit == picture.FitFill && r != image.Rect(0, 0, 200, 144)) || (fit == picture.FitCover && r.Dy() < 144) {
			t.Fatalf("%v: %v", fit, r)
		}
	}
}

// sixelHome is a home screen on a terminal that draws Sixel (Windows Terminal's DA1), its window
// 1170×680 pixels at 130×34 cells: 9×20-pixel cells.
func sixelHome(t *testing.T) (*Model, tea.Cmd) {
	t.Helper()
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	m.Update(uv.PixelSizeEvent{Width: 1170, Height: 680})
	_, cmd := m.Update(uv.PrimaryDeviceAttributesEvent{61, 4, 6, 7, 14, 21, 22})
	return m, cmd
}

// drawn renders the frame (so the zones are known), then runs cmd and returns what it writes.
func drawn(t *testing.T, m *Model, cmd tea.Cmd) (string, bool) {
	t.Helper()
	m.View()
	time.Sleep(20 * time.Millisecond)
	return sixelOutput(t, m, cmd)
}

func TestTheHomeWallpaperStaysInCellsEvenWhereSixelIsDrawn(t *testing.T) {
	// Sixel pixels are erased by text written over them, and the whole screen is drawn over the
	// wallpaper; so the wallpaper is half blocks on every terminal, and no Sixel is written.
	m, cmd := sixelHome(t)
	m.opts.NoWallpaper = false
	s := screen(m)
	if !strings.Contains(s, "▀") || !strings.Contains(s, "by "+m.homePhoto().By) || !strings.Contains(s, "a coding agent that shows its work") {
		t.Fatalf("no wallpaper, credit or card on a Sixel terminal:\n%s", s)
	}
	if raw, _ := drawn(t, m, cmd); strings.Contains(raw, "\x1bP0;1q") {
		t.Fatal("the home screen drew Sixel over its card")
	}
}

func TestWithoutSixelTheWallpaperIsGlyphsAndNothingIsWrittenOverIt(t *testing.T) {
	m := projectModel(t)
	m.opts.NoWallpaper = false
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	_, cmd := m.Update(uv.PrimaryDeviceAttributesEvent{62, 22}) // no 4
	if strings.Count(screen(m), "▀") == 0 {
		t.Fatal("no glyph wallpaper")
	}
	if raw, _ := drawn(t, m, cmd); raw != "" {
		t.Fatal("wrote a picture to a terminal that does not draw Sixel")
	}
}
