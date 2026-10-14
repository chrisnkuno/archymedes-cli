package prism

import (
	"fmt"
	"image"
	"strings"
)

// Glyphs turns an image into terminal cells the way Chafa does: each cell is 8×8 pixels of the
// image, and is drawn as whichever block character — halves, quadrants, eighths — with whichever
// two colours (foreground for the shape, background for the rest) reproduces those 64 pixels most
// closely. That keeps the outline of a thin edge or a highlight inside a cell, where half-blocks
// alone would smear it into two pixels. Cells with nothing of the mark in them are plain spaces,
// so the terminal's own background shows; part of a cell that is background is drawn in the
// background colour the image was composited on.

// CellPixels is the sampling grid of one cell.
const CellPixels = 8

// glyphMask is a block character and which of a cell's 8×8 pixels it covers (bit y*8+x).
type glyphMask struct {
	r    rune
	mask uint64
}

var glyphMasks = func() []glyphMask {
	rect := func(x0, y0, x1, y1 int) uint64 {
		var m uint64
		for y := y0; y < y1; y++ {
			for x := x0; x < x1; x++ {
				m |= 1 << (y*8 + x)
			}
		}
		return m
	}
	tl, tr, bl, br := rect(0, 0, 4, 4), rect(4, 0, 8, 4), rect(0, 4, 4, 8), rect(4, 4, 8, 8)
	out := []glyphMask{
		{'█', rect(0, 0, 8, 8)},
		{'▀', rect(0, 0, 8, 4)}, {'▄', rect(0, 4, 8, 8)}, {'▌', rect(0, 0, 4, 8)}, {'▐', rect(4, 0, 8, 8)},
		{'▘', tl}, {'▝', tr}, {'▖', bl}, {'▗', br}, {'▚', tl | br}, {'▞', tr | bl},
		{'▛', tl | tr | bl}, {'▜', tl | tr | br}, {'▙', tl | bl | br}, {'▟', tr | bl | br},
		{'▔', rect(0, 0, 8, 1)}, {'▕', rect(7, 0, 8, 8)},
	}
	for i, r := range []rune{'▁', '▂', '▃', '▅', '▆', '▇'} { // lower eighths (▄ is the half)
		n := []int{1, 2, 3, 5, 6, 7}[i]
		out = append(out, glyphMask{r, rect(0, 8-n, 8, 8)})
	}
	for i, r := range []rune{'▏', '▎', '▍', '▋', '▊', '▉'} { // left eighths (▌ is the half)
		n := []int{1, 2, 3, 5, 6, 7}[i]
		out = append(out, glyphMask{r, rect(0, 0, n, 8)})
	}
	return out
}()

// Glyphs renders img (whose size is a multiple of CellPixels each way) as cols×rows cells of
// truecolor ANSI text, one string per row.
func Glyphs(img *image.NRGBA) []string {
	b := img.Bounds()
	cols, rows := b.Dx()/CellPixels, b.Dy()/CellPixels
	lines := make([]string, rows)
	var px [64][3]float64
	var alpha [64]float64
	for cy := range rows {
		var line strings.Builder
		lastFG, lastBG := "", ""
		for cx := range cols {
			// The cell's pixels, and how much of them is the mark.
			cover := 0.0
			for y := range 8 {
				for x := range 8 {
					c := img.NRGBAAt(b.Min.X+cx*8+x, b.Min.Y+cy*8+y)
					i := y*8 + x
					px[i] = [3]float64{float64(c.R), float64(c.G), float64(c.B)}
					alpha[i] = float64(c.A) / 255
					cover += alpha[i]
				}
			}
			if cover < 0.6 { // under one pixel's worth: the terminal's own background
				if lastFG != "" || lastBG != "" {
					line.WriteString("\x1b[m")
					lastFG, lastBG = "", ""
				}
				line.WriteByte(' ')
				continue
			}
			r, fg, bg, bgAlpha := bestGlyph(&px, &alpha)
			fgCode := fmt.Sprintf("\x1b[38;2;%d;%d;%dm", fg[0], fg[1], fg[2])
			bgCode := fmt.Sprintf("\x1b[48;2;%d;%d;%dm", bg[0], bg[1], bg[2])
			if bgAlpha < 0.08 {
				bgCode = "\x1b[49m" // the rest of the cell is background: let the terminal's show
			}
			if fgCode != lastFG {
				line.WriteString(fgCode)
				lastFG = fgCode
			}
			if bgCode != lastBG {
				line.WriteString(bgCode)
				lastBG = bgCode
			}
			line.WriteRune(r)
		}
		if lastFG != "" || lastBG != "" {
			line.WriteString("\x1b[m")
		}
		lines[cy] = line.String()
	}
	return lines
}

// bestGlyph is the block character and two colours closest to a cell's pixels (least squared
// error), and how much of the mark is in the background part.
func bestGlyph(px *[64][3]float64, alpha *[64]float64) (rune, [3]uint8, [3]uint8, float64) {
	var total [3]float64
	var totalSq, totalA float64
	for i := range 64 {
		for c := range 3 {
			total[c] += px[i][c]
			totalSq += px[i][c] * px[i][c]
		}
		totalA += alpha[i]
	}
	best, bestErr := glyphMasks[0], 1e300
	var bestFG, bestBG [3]float64
	bestBGA := 0.0
	for _, g := range glyphMasks {
		var on [3]float64
		var onSq, onA float64
		n := 0
		for i := range 64 {
			if g.mask&(1<<i) != 0 {
				for c := range 3 {
					on[c] += px[i][c]
					onSq += px[i][c] * px[i][c]
				}
				onA += alpha[i]
				n++
			}
		}
		off := [3]float64{total[0] - on[0], total[1] - on[1], total[2] - on[2]}
		offSq := totalSq - onSq
		// Squared error of each part about its own mean: Σx² − (Σx)²/n.
		err := onSq - (on[0]*on[0]+on[1]*on[1]+on[2]*on[2])/float64(n)
		if m := 64 - n; m > 0 {
			err += offSq - (off[0]*off[0]+off[1]*off[1]+off[2]*off[2])/float64(m)
		}
		if err < bestErr-1e-6 {
			best, bestErr = g, err
			bestFG = [3]float64{on[0] / float64(n), on[1] / float64(n), on[2] / float64(n)}
			if m := 64 - n; m > 0 {
				bestBG = [3]float64{off[0] / float64(m), off[1] / float64(m), off[2] / float64(m)}
				bestBGA = (totalA - onA) / float64(m)
			} else {
				bestBG, bestBGA = bestFG, 1
			}
		}
	}
	return best.r, to8(bestFG), to8(bestBG), bestBGA
}

func to8(c [3]float64) [3]uint8 {
	return [3]uint8{uint8(c[0] + 0.5), uint8(c[1] + 0.5), uint8(c[2] + 0.5)}
}
