package tui

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/NimbleMarkets/ntcharts/v2/picture"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/ansi/sixel"
	xdraw "golang.org/x/image/draw"
)

// Sixel pictures for the Gallery, in terminals that draw Sixel but not Kitty graphics — Windows
// Terminal, foot, mlterm, VS Code's terminal with images on. ntcharts' picture component speaks
// glyphs and Kitty; this adds the third. Glyphs are two pixels a cell, so however large the photo,
// a pane of 55×40 cells is 55×80 pixels; Sixel draws the photo's own pixels.
//
// A Sixel image is not part of the cell grid Bubble Tea draws: it is written over it. So the cells
// under a picture are left blank in the frame, and once the frame is on screen the image is written
// at those cells' position (cursor saved and restored around it). The renderer only redraws cells
// that change, and blank cells do not, so the image stays. It is drawn again when anything that
// would cover or move it changes — the photo, the size, the fit, a dialog closing — and when the
// Gallery stops being what is on screen the whole screen is cleared, so no picture is left behind.

// sixelSettle is how long after a change the image is written: after the frame showing the blank
// cells has reached the terminal (the renderer draws at most 60 times a second).
const sixelSettle = 80 * time.Millisecond

type sixelDrawMsg struct{ signature string }

// pictureMode is how the Gallery draws: the best the terminal has, unless chosen with g.
type pictureMode int

const (
	modeGlyph pictureMode = iota
	modeKitty
	modeSixel
)

func (p pictureMode) String() string {
	return [...]string{"glyphs", "Kitty graphics", "Sixel"}[p]
}

// modes are the ways this terminal can draw, best last.
func (g *galleryApp) modes() []pictureMode {
	out := []pictureMode{modeGlyph}
	if g.builtIn.KittySupported() == picture.KittyCapabilitySupported {
		out = append(out, modeKitty)
	}
	if g.sixel {
		out = append(out, modeSixel)
	}
	return out
}

// setMode switches both pictures to mode.
func (g *galleryApp) setMode(mode pictureMode) tea.Cmd {
	var cmds []tea.Cmd
	// The picture models know glyphs and Kitty; for Sixel they stay on glyphs (and are not shown).
	wantKitty := mode == modeKitty
	if (g.builtIn.Mode() == picture.PictureKitty) != wantKitty {
		cmds = append(cmds, g.builtIn.Toggle(), g.live.Toggle())
	}
	g.mode, g.chosen = mode, true
	return tea.Batch(cmds...)
}

// upgrade moves to the best mode the terminal turned out to have, unless someone chose one.
func (g *galleryApp) upgrade() tea.Cmd {
	if g.chosen {
		return nil
	}
	modes := g.modes()
	best := modes[len(modes)-1]
	if best == g.mode {
		return nil
	}
	cmd := g.setMode(best)
	g.chosen = false
	return cmd
}

// cellPixels is the terminal's cell size in pixels: as it reported, or worked out from its window
// size in pixels, or the common 8×16.
func (m *Model) cellPixels() (int, int) {
	switch {
	case m.cellW > 0 && m.cellH > 0:
		return m.cellW, m.cellH
	case m.pixelW > 0 && m.pixelH > 0 && m.width > 0 && m.height > 0:
		return max(m.pixelW/m.width, 1), max(m.pixelH/m.height, 1)
	}
	return 8, 16
}

// sixelScene is what decides the Sixel pictures now on screen, in two parts: place — which
// screen, and everything that decides where its pictures sit — and content, what they show. Both
// are "" when no picture may be drawn: Sixel is off, or a dialog is over the screen.
func (m *Model) sixelScene() (place, content string) {
	if m.overlay != nil || m.approval != nil {
		return "", ""
	}
	cw, ch := m.cellPixels()
	if g := m.galleryWindow(); g != nil && m.activeWindow() == g {
		if g.mode != modeSixel || g.layout(m).panes == 0 {
			return "", ""
		}
		return fmt.Sprintf("gallery|%dx%d|%dx%d", m.width, m.height, cw, ch),
			fmt.Sprintf("%d|%d|%v|%s|%d", g.index, g.builtIn.Fit(), g.liveImage() != nil, g.live.CurrentURL(), len(m.toasts))
	}
	return "", ""
}

// sixelAfter is called after every message. When the pictures should look different: if they
// moved (or must go), the screen is cleared so the renderer draws every cell again and nothing of
// them is left; then, a moment later, they are drawn again.
func (m *Model) sixelAfter() tea.Cmd {
	place, content := m.sixelScene()
	sig := ""
	if place != "" {
		sig = place + "§" + content
	}
	if sig == m.sixelSig {
		return nil
	}
	previous := m.sixelPlace
	m.sixelSig, m.sixelPlace = sig, place
	var cmds []tea.Cmd
	if previous != "" && previous != place {
		cmds = append(cmds, tea.ClearScreen)
	}
	if sig != "" {
		cmds = append(cmds, tea.Tick(sixelSettle, func(time.Time) tea.Msg { return sixelDrawMsg{signature: sig} }))
	}
	return tea.Batch(cmds...)
}

// sixelDraw writes the pictures, if nothing has changed since they were asked for.
func (m *Model) sixelDraw(msg sixelDrawMsg) tea.Cmd {
	if msg.signature == "" || msg.signature != m.sixelSig {
		return nil
	}
	var out strings.Builder
	out.WriteString(ansi.SaveCursor)
	switch {
	case strings.HasPrefix(msg.signature, "gallery|"):
		g := m.galleryWindow()
		if g == nil {
			return nil
		}
		var l galleryLayout
		m.within(func() { l = g.layout(m) })
		for i, img := range []image.Image{g.builtInImage(), g.liveImage()} {
			if i >= l.panes || img == nil {
				continue
			}
			// The picture's cells: inside the pane's border, under its label.
			col := m.winOrigin.X + i*(l.paneWidth+1) + 1
			row := m.winOrigin.Y + 1 + 1 + 1 // Gallery header, pane border, pane label
			out.WriteString(ansi.CursorPosition(col+1, row+1))
			out.WriteString(m.sixelPicture(img, l.innerCols, l.pictureRow, g.builtIn.Fit()))
		}
	default:
		return nil
	}
	out.WriteString(ansi.RestoreCursor)
	return tea.Raw(out.String())
}

// sixelPicture is img fitted to cols×rows cells, as a Sixel sequence filling them exactly.
func (m *Model) sixelPicture(img image.Image, cols, rows int, fit picture.FitMode) string {
	cw, ch := m.cellPixels()
	w, h := cols*cw, rows*ch
	// Sixel draws in bands of six pixel rows; a last band that runs past the cells would spill
	// onto the captions, so the height is rounded down to a whole band.
	h -= h % 6
	canvas := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(canvas, canvas.Bounds(), &image.Uniform{C: themeBackground(m)}, image.Point{}, draw.Src)
	src := img.Bounds()
	dst := fitRect(src.Dx(), src.Dy(), w, h, fit)
	xdraw.CatmullRom.Scale(canvas, dst, img, src, xdraw.Over, nil)
	var payload bytes.Buffer
	if err := (&sixel.Encoder{}).Encode(&payload, canvas); err != nil {
		return ""
	}
	return ansi.SixelGraphics(0, 1, 0, payload.Bytes())
}

// fitRect is where a sw×sh image goes in a w×h box: whole and centred (contain), filling it
// and cropped (cover), or stretched (fill).
func fitRect(sw, sh, w, h int, fit picture.FitMode) image.Rectangle {
	if fit == picture.FitFill || sw == 0 || sh == 0 {
		return image.Rect(0, 0, w, h)
	}
	scale := min(float64(w)/float64(sw), float64(h)/float64(sh))
	if fit == picture.FitCover {
		scale = max(float64(w)/float64(sw), float64(h)/float64(sh))
	}
	dw, dh := int(float64(sw)*scale), int(float64(sh)*scale)
	x, y := (w-dw)/2, (h-dh)/2
	return image.Rect(x, y, x+dw, y+dh)
}

// themeBackground is the theme's background colour, for the bars beside a contained photo.
func themeBackground(m *Model) color.Color {
	if m.th.Bg != nil {
		return m.th.Bg
	}
	return color.Black
}
