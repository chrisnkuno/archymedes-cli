package tui

import (
	"image/color"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
)

// renderRow writes a one-row canvas out as text, byte for byte as the canvas's own Render does
// (ultraviolet's renderLine), faster where the wallpaper spends its time. Most cells of a row over
// the photo differ from the one before only in their two colours, each a plain RGB: for those the
// change is written straight into the buffer, where Render builds a style diff through
// interfaces and string joins for every cell. Any other change goes through Render's own diff.
func renderRow(canvas *lipgloss.Canvas, width int) string {
	var b strings.Builder
	b.Grow(width * 24)
	var pen uv.Style
	var link uv.Link
	pending := 0 // blank cells held back, written when something follows them
	num := make([]byte, 0, 48)
	for x := range width {
		c := canvas.CellAt(x, 0)
		if c == nil || c.IsZero() {
			continue
		}
		if c.Equal(&uv.EmptyCell) {
			if !pen.IsZero() {
				b.WriteString(ansi.ResetStyle)
				pen = uv.Style{}
			}
			if !link.IsZero() {
				b.WriteString(ansi.ResetHyperlink())
				link = uv.Link{}
			}
			pending++
			continue
		}
		for ; pending > 0; pending-- {
			b.WriteByte(' ')
		}
		if c.Style.IsZero() && !pen.IsZero() {
			b.WriteString(ansi.ResetStyle)
			pen = uv.Style{}
		}
		if !c.Style.Equal(&pen) {
			if seq, ok := colourOnlyDiff(num[:0], &pen, &c.Style); ok {
				b.Write(seq)
			} else {
				b.WriteString(c.Style.Diff(&pen))
			}
			pen = c.Style
		}
		if c.Link != link && link.URL != "" {
			b.WriteString(ansi.ResetHyperlink())
			link = uv.Link{}
		}
		if c.Link != link {
			b.WriteString(ansi.SetHyperlink(c.Link.URL, c.Link.Params))
			link = c.Link
		}
		b.WriteString(c.Content)
	}
	for ; pending > 0; pending-- {
		b.WriteByte(' ')
	}
	if link.URL != "" {
		b.WriteString(ansi.ResetHyperlink())
	}
	if !pen.IsZero() {
		b.WriteString(ansi.ResetStyle)
	}
	return b.String()
}

// colourOnlyDiff is the SGR for a change of foreground and background alone, each a plain RGB or
// the default, appended to buf: the sequence ultraviolet's StyleDiff writes for it. ok is false for
// any other change, which StyleDiff then writes.
func colourOnlyDiff(buf []byte, from, to *uv.Style) ([]byte, bool) {
	if from.Attrs != to.Attrs || from.Underline != to.Underline || !sameColour(from.UnderlineColor, to.UnderlineColor) {
		return nil, false
	}
	fg, fgOK := plainRGB(to.Fg)
	bg, bgOK := plainRGB(to.Bg)
	if !fgOK || !bgOK {
		return nil, false
	}
	fgChanged, bgChanged := !sameColour(from.Fg, to.Fg), !sameColour(from.Bg, to.Bg)
	if !fgChanged && !bgChanged {
		return nil, false
	}
	buf = append(buf, "\x1b["...)
	if fgChanged {
		buf = appendSGRColour(buf, "38", "39", fg, to.Fg == nil)
	}
	if bgChanged {
		if fgChanged {
			buf = append(buf, ';')
		}
		buf = appendSGRColour(buf, "48", "49", bg, to.Bg == nil)
	}
	return append(buf, 'm'), true
}

func appendSGRColour(buf []byte, set, reset string, c color.RGBA, isDefault bool) []byte {
	if isDefault {
		return append(buf, reset...)
	}
	buf = append(buf, set...)
	buf = append(buf, ";2;"...)
	buf = strconv.AppendUint(buf, uint64(c.R), 10)
	buf = append(buf, ';')
	buf = strconv.AppendUint(buf, uint64(c.G), 10)
	buf = append(buf, ';')
	return strconv.AppendUint(buf, uint64(c.B), 10)
}

// plainRGB is c as RGB when it is written as 24-bit colour (or nil, the default); ok is false for
// the ANSI and 256-colour kinds, which are written as their own codes.
func plainRGB(c color.Color) (color.RGBA, bool) {
	switch v := c.(type) {
	case nil:
		return color.RGBA{}, true
	case color.RGBA:
		return v, true
	}
	return color.RGBA{}, false
}

func sameColour(a, b color.Color) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ar, ag, ab, aa := a.RGBA()
	br, bg, bb, ba := b.RGBA()
	return ar == br && ag == bg && ab == bb && aa == ba
}
