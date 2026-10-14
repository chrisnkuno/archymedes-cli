package prism

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

var testPalette = Palette{
	Primary:    color.RGBA{38, 139, 210, 255},
	Secondary:  color.RGBA{42, 161, 152, 255},
	Accent:     color.RGBA{181, 137, 0, 255},
	Background: color.RGBA{0, 43, 54, 255},
}

func TestPeek(t *testing.T) {
	out := os.Getenv("PRISM_PNG")
	if out == "" {
		t.Skip()
	}
	img := Render(Pose{Yaw: 0.5, Tilt: 0.35}, testPalette, 360, 344, 1, 2)
	// As the terminal shows it: the colours over the background (alpha is only coverage).
	for i := 3; i < len(img.Pix); i += 4 {
		img.Pix[i] = 255
	}
	f, _ := os.Create(out)
	png.Encode(f, img)
	f.Close()
}

// cellsToImage draws Glyphs output back as pixels (8×16 per cell), to look at what a terminal shows.
func cellsToImage(lines []string, cols int, bg color.Color) *image.NRGBA {
	masks := map[rune]uint64{' ': 0}
	for _, g := range glyphMasks {
		masks[g.r] = g.mask
	}
	img := image.NewNRGBA(image.Rect(0, 0, cols*8, len(lines)*16))
	for y, line := range lines {
		var fg, cbg color.Color = bg, bg
		x := 0
		for i := 0; i < len(line); {
			if line[i] == 0x1b {
				j := strings.IndexByte(line[i:], 'm')
				code := line[i+2 : i+j]
				var r, g, b int
				switch {
				case strings.HasPrefix(code, "38;2;"):
					fmt.Sscanf(code, "38;2;%d;%d;%d", &r, &g, &b)
					fg = color.RGBA{uint8(r), uint8(g), uint8(b), 255}
				case strings.HasPrefix(code, "48;2;"):
					fmt.Sscanf(code, "48;2;%d;%d;%d", &r, &g, &b)
					cbg = color.RGBA{uint8(r), uint8(g), uint8(b), 255}
				case code == "49", code == "":
					cbg = bg
				}
				i += j + 1
				continue
			}
			r, size := utf8.DecodeRuneInString(line[i:])
			i += size
			m := masks[r]
			for py := range 16 {
				for px := range 8 {
					c := cbg
					if r != ' ' && m&(1<<((py/2)*8+px)) != 0 {
						c = fg
					}
					img.Set(x*8+px, y*16+py, c)
				}
			}
			x++
		}
	}
	return img
}

func TestPeekGlyphs(t *testing.T) {
	out := os.Getenv("PRISM_GLYPHS_PNG")
	if out == "" {
		t.Skip()
	}
	cols, rows := 30, 14
	if os.Getenv("SMALL") != "" {
		cols, rows = 23, 11
	}
	img := Render(Pose{Yaw: 2.7, Tilt: 0.35, Bold: 1}, testPalette, cols*CellPixels, rows*CellPixels, 0.5, 2)
	view := cellsToImage(Glyphs(img), cols, testPalette.Background)
	f, _ := os.Create(out)
	png.Encode(f, view)
	f.Close()
}
