package tui

import (
	"fmt"
	"image"
	"image/color"

	"charm.land/lipgloss/v2"
	uv "github.com/charmbracelet/ultraviolet"
	xdraw "golang.org/x/image/draw"
)

// The wallpaper: the day's photo behind the whole screen, top bar to dock, every window.
//
// It is laid under the finished frame cell by cell, so nothing that draws the screen has to know
// it is there. A cell with nothing in it shows the photo (two of its pixels, in a half block); a
// cell with a glyph and no background keeps the glyph on the photo's colour there; a cell that
// paints its own background (a bar, a card, a selection) keeps it, with a little of the photo
// mixed in, like frosted glass. The photo is dimmed toward the theme's ground, more once there is
// a conversation to read.
//
// Terminal graphics cannot do this: Sixel pixels are erased by any text written over them, and
// Windows Terminal has no Kitty graphics, which could put a picture under text. Half blocks can,
// everywhere, and the photo is scaled to the cell grid with a Catmull-Rom filter rather than by
// nearest pixel, so it reads as a soft picture rather than a mosaic.

const (
	// wallpaperKeepHome is how much of the photo shows on the home screen; the rest is the ground.
	wallpaperKeepHome = 0.5
	// wallpaperKeepWork is how much shows behind a conversation or an app, where text comes first.
	wallpaperKeepWork = 0.2
	// glassMix is how much of the photo shows through a cell that paints its own background.
	glassMix = 0.3
)

// wallpaperGrid is the photo as two colours per cell, top and bottom half.
type wallpaperGrid struct {
	w, h        int
	top, bottom []color.RGBA
}

func (g *wallpaperGrid) at(x, y int) (color.RGBA, color.RGBA) {
	i := y*g.w + x
	return g.top[i], g.bottom[i]
}

// wallpaperKeep is how much of the photo shows now.
func (m *Model) wallpaperKeep() float64 {
	if m.activeWindow() == nil && m.landingVisible() {
		return wallpaperKeepHome
	}
	return wallpaperKeepWork
}

// wallpaper is the grid for the current photo at width×height, or nil when photos are off.
func (m *Model) wallpaper(width, height int) *wallpaperGrid {
	if m.wallpaperOff() || width <= 0 || height <= 0 {
		return nil
	}
	p := m.homePhoto()
	keep := m.wallpaperKeep()
	key := fmt.Sprintf("%s|%dx%d|%.2f|%s", p.ID, width, height, keep, m.th.Name)
	if m.wall != nil && m.wallKey == key {
		return m.wall
	}
	img, err := p.Image()
	if err != nil {
		return nil
	}
	m.wall, m.wallKey = buildWallpaper(img, width, height, keep, m.th.Bg), key
	return m.wall
}

// buildWallpaper scales img to cover width×(2·height) pixels, cropped about its centre, and dims
// each pixel toward ground.
func buildWallpaper(img image.Image, width, height int, keep float64, ground color.Color) *wallpaperGrid {
	pw, ph := width, height*2
	src := img.Bounds()
	// Cover: the largest centred part of the photo with the screen's shape. A cell is about twice as
	// tall as it is wide, and each holds two pixels vertically, so a pixel here is about square.
	crop := src
	if src.Dx()*ph > src.Dy()*pw {
		w := src.Dy() * pw / ph
		crop = image.Rect(src.Min.X+(src.Dx()-w)/2, src.Min.Y, src.Min.X+(src.Dx()-w)/2+w, src.Max.Y)
	} else {
		h := src.Dx() * ph / pw
		crop = image.Rect(src.Min.X, src.Min.Y+(src.Dy()-h)/2, src.Max.X, src.Min.Y+(src.Dy()-h)/2+h)
	}
	scaled := image.NewRGBA(image.Rect(0, 0, pw, ph))
	xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), img, crop, xdraw.Src, nil)

	gr := toRGBA(ground)
	g := &wallpaperGrid{w: width, h: height, top: make([]color.RGBA, width*height), bottom: make([]color.RGBA, width*height)}
	for y := range height {
		for x := range width {
			g.top[y*width+x] = mixRGBA(scaled.RGBAAt(x, 2*y), gr, keep)
			g.bottom[y*width+x] = mixRGBA(scaled.RGBAAt(x, 2*y+1), gr, keep)
		}
	}
	return g
}

// panelRows are the screen's chrome, frosted across their whole width: the top bar, the dock and,
// in Chat, the input box and its completions.
func (m *Model) panelRows(height int) map[int]bool {
	rows := map[int]bool{0: true, height - 1: true}
	if m.activeWindow() == nil {
		for y := height - 1 - m.composerHeight() - m.dropupRows(); y < height; y++ {
			rows[y] = true
		}
	}
	return rows
}

// underlay lays the wallpaper under a finished frame of width×height.
func (m *Model) underlay(content string, width, height int) string {
	g := m.wallpaper(width, height)
	if g == nil {
		return content
	}
	// Most frames are the last one again (a cursor that did not move, a tick with nothing to show):
	// laying the wallpaper costs a few milliseconds a frame, so an unchanged frame reuses it.
	if m.underIn == content && m.underGrid == g {
		return m.underOut
	}
	ground := toRGBA(m.th.Bg)
	panels := m.panelRows(height)
	canvas := lipgloss.NewCanvas(width, height)
	canvas.Compose(lipgloss.NewLayer(content))
	isBlank := func(c *uv.Cell) bool { return c == nil || c.Content == " " || (c.Content == "" && c.Width > 0) }
	for y := range height {
		// Where the text on this row is: the gaps inside a run of words, and a cell either side of
		// it, are glass too, so a line reads as one frosted strip rather than words cut out of it.
		text := make([]bool, width)
		for x := range width {
			c := canvas.CellAt(x, y)
			text[x] = !isBlank(c) && c.Style.Bg == nil
		}
		near := func(x, reach int, step int) bool {
			for i := 1; i <= reach; i++ {
				if j := x + i*step; j >= 0 && j < width && text[j] {
					return true
				}
			}
			return false
		}
		for x := range width {
			cell := canvas.CellAt(x, y)
			if cell == nil || cell.Width == 0 {
				continue // the second column of a wide glyph
			}
			top, bottom := g.at(x, y)
			photo := mixRGBA(top, bottom, 0.5)
			blank := isBlank(cell) && !(near(x, 1, -1) || near(x, 1, 1) || (near(x, 3, -1) && near(x, 3, 1)))
			switch {
			case cell.Style.Bg != nil:
				// A cell that paints its own ground: frosted glass.
				cell.Style.Bg = mixRGBA(toRGBA(cell.Style.Bg), photo, 1-glassMix)
			case blank && !panels[y]:
				// Nothing here: the photo, two pixels in a half block.
				cell.Content, cell.Width = "▀", 1
				cell.Style.Fg, cell.Style.Bg = top, bottom
				cell.Style.Attrs, cell.Style.Underline = 0, 0
			default:
				// A glyph, or the chrome: on frosted glass, so it reads over any part of the photo.
				cell.Style.Bg = mixRGBA(ground, photo, 1-glassMix)
			}
		}
	}
	m.underIn, m.underGrid, m.underOut = content, g, fillHeight(canvas.Render(), height)
	return m.underOut
}

func toRGBA(c color.Color) color.RGBA {
	if c == nil {
		return color.RGBA{A: 255}
	}
	r, g, b, _ := c.RGBA()
	return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), 255}
}

// mixRGBA is a·keep + b·(1-keep).
func mixRGBA(a, b color.RGBA, keep float64) color.RGBA {
	mix := func(x, y uint8) uint8 { return uint8(float64(x)*keep + float64(y)*(1-keep) + 0.5) }
	return color.RGBA{mix(a.R, b.R), mix(a.G, b.G), mix(a.B, b.B), 255}
}
