package tui

import (
	"hash/fnv"
	"image/color"
	"path"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// The Finder's icons: small pictures in text, coloured from the theme so they follow /theme. Each
// kind of thing has its own shape: a rounded app icon in a gradient, a terminal window for a
// command, a speech bubble for a session, a folder, a page with its file type on a coloured band.
// Every icon is five rows; finderArt centres it in a tile with a faint line under it.

// finderPalette is the theme's six colours, the ones icons are painted in.
func finderPalette(th theme.Theme) []color.Color {
	return []color.Color{th.Primary, th.Secondary, th.Accent, th.Success, th.Warning, th.Error}
}

// hue picks a colour for name from the palette, the same one every time.
func hue(th theme.Theme, name string) color.Color {
	h := fnv.New32a()
	h.Write([]byte(name))
	p := finderPalette(th)
	return p[int(h.Sum32()%uint32(len(p)))]
}

// toward is a between b and c, at t (0 is b, 1 is c).
func toward(b, c color.Color, t float64) color.Color {
	steps := lipgloss.Blend1D(11, b, c)
	return steps[min(max(int(t*10+0.5), 0), 10)]
}

func fg(c color.Color) lipgloss.Style { return lipgloss.NewStyle().Foreground(c) }
func bg(c color.Color) lipgloss.Style { return lipgloss.NewStyle().Background(c) }

// centred is text centred in width cells.
func centred(text string, width int) string {
	text = ansi.Truncate(text, width, "…")
	pad := max(width-ansi.StringWidth(text), 0)
	return strings.Repeat(" ", pad/2) + text + strings.Repeat(" ", pad-pad/2)
}

// finderArt lays an icon in a tile: the icon at the top, then a faint line (a key, a count, a time).
func finderArt(icon func(th theme.Theme) []string, note string) func(*Model, int, int) []string {
	return func(m *Model, cols, rows int) []string {
		lines := icon(m.th)
		out := make([]string, 0, rows)
		for _, line := range lines {
			w := ansi.StringWidth(line)
			pad := max(cols-w, 0)
			out = append(out, strings.Repeat(" ", pad/2)+line+strings.Repeat(" ", pad-pad/2))
		}
		for len(out) < rows-1 {
			out = append(out, strings.Repeat(" ", cols))
		}
		return append(out[:rows-1], m.th.Faint.Render(centred(note, cols)))
	}
}

// appIcon is a rounded square in a gradient of two colours, the app's glyph in the middle.
func appIcon(glyph string, a, b color.Color) func(theme.Theme) []string {
	return func(th theme.Theme) []string {
		ramp := lipgloss.Blend1D(4, a, b)
		row := func(c color.Color, text string) string { return bg(c).Render(centred(text, 9)) }
		return []string{
			fg(ramp[0]).Render("▗▄▄▄▄▄▄▄▖"),
			row(ramp[0], ""),
			bg(ramp[1]).Foreground(th.Bg).Bold(true).Render(centred(glyph, 9)),
			row(ramp[2], ""),
			fg(ramp[3]).Render("▝▀▀▀▀▀▀▀▘"),
		}
	}
}

// commandIcon is a terminal window: three lights in its title bar, a prompt and the command's start.
func commandIcon(name string) func(theme.Theme) []string {
	return func(th theme.Theme) []string {
		bar := toward(th.Surface, th.Text, 0.25)
		panel := toward(th.Surface, th.Bg, 0.6)
		lights := bg(bar).Render(" ") + bg(bar).Foreground(th.Error).Render("●") + bg(bar).Foreground(th.Warning).Render("●") +
			bg(bar).Foreground(th.Success).Render("●") + bg(bar).Render(strings.Repeat(" ", 6))
		word := ansi.Truncate(strings.TrimPrefix(name, "/"), 6, "")
		prompt := bg(panel).Foreground(th.Success).Bold(true).Render(" › ") + bg(panel).Foreground(th.Text).Render(word+strings.Repeat(" ", 6-ansi.StringWidth(word)))
		return []string{
			fg(bar).Render("▗▄▄▄▄▄▄▄▖"),
			lights,
			prompt,
			bg(panel).Foreground(th.Accent).Render(" ▁       "),
			fg(panel).Render("▝▀▀▀▀▀▀▀▘"),
		}
	}
}

// sessionIcon is a speech bubble with lines of conversation in it.
func sessionIcon(c color.Color) func(theme.Theme) []string {
	return func(th theme.Theme) []string {
		ink := toward(c, th.Bg, 0.55)
		return []string{
			fg(c).Render("▗▄▄▄▄▄▄▄▖"),
			bg(c).Foreground(ink).Render("  ━━━━━  "),
			bg(c).Foreground(ink).Render("  ━━━    "),
			fg(c).Render("▝▀█▀▀▀▀▀▘"),
			fg(c).Render("  ▀      "),
		}
	}
}

// folderIcon is a folder: a lighter tab over a body that darkens toward its foot.
func folderIcon(c color.Color) func(theme.Theme) []string {
	return func(th theme.Theme) []string {
		tab := toward(c, th.Text, 0.3)
		low := toward(c, th.Bg, 0.3)
		return []string{
			fg(tab).Render("▗▄▄▄▄▖     "),
			bg(tab).Render(strings.Repeat(" ", 11)),
			bg(c).Render(strings.Repeat(" ", 11)),
			bg(low).Render(strings.Repeat(" ", 11)),
			fg(low).Render("▝▀▀▀▀▀▀▀▀▀▘"),
		}
	}
}

// fileIcon is a page with its type on a band in the type's colour.
func fileIcon(name string) func(theme.Theme) []string {
	return func(th theme.Theme) []string {
		ext := strings.ToUpper(strings.TrimPrefix(path.Ext(name), "."))
		if ext == "" {
			ext = "TXT"
		}
		band := hue(th, ext)
		page := toward(th.Surface, th.Text, 0.7)
		ink := toward(page, th.Bg, 0.45)
		return []string{
			fg(band).Render("▗▄▄▄▄▄▄▖"),
			bg(band).Foreground(th.Bg).Bold(true).Render(centred(ansi.Truncate(ext, 6, ""), 8)),
			bg(page).Foreground(ink).Render(" ━━━━━  "),
			bg(page).Foreground(ink).Render(" ━━━    "),
			fg(page).Render("▝▀▀▀▀▀▀▘"),
		}
	}
}
