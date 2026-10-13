package theme

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/rivo/uniseg"
)

// The design system's derived pieces: gradients, pills and tints, always computed from a theme's
// roles so every palette (including the 16-colour high-contrast one) gets them for free. Lip Gloss
// downsamples to whatever the terminal can show, so these degrade rather than break.

// Gradient renders text with a left-to-right blend from one colour to another, one grapheme at a time.
func Gradient(text string, from, to color.Color, bold bool) string {
	var clusters []string
	g := uniseg.NewGraphemes(text)
	for g.Next() {
		clusters = append(clusters, g.Str())
	}
	if len(clusters) == 0 {
		return ""
	}
	ramp := lipgloss.Blend1D(max(len(clusters), 2), from, to)
	var b strings.Builder
	for i, cluster := range clusters {
		if strings.TrimSpace(cluster) == "" {
			b.WriteString(cluster)
			continue
		}
		b.WriteString(lipgloss.NewStyle().Foreground(ramp[i]).Bold(bold).Render(cluster))
	}
	return b.String()
}

// Tint is c mixed into the theme's ground by amount (0 = the ground, 1 = c): the backgrounds of
// added and removed diff rows, and of a selected row, are tints so text on them stays legible.
func (th Theme) Tint(c color.Color, amount float64) color.Color {
	steps := lipgloss.Blend1D(21, th.Bg, c)
	return steps[max(0, min(20, int(amount*20+0.5)))]
}

// Pill is a short label set on a filled background: a mode, a model, a tool's state.
func (th Theme) Pill(text string, bg color.Color) string {
	return lipgloss.NewStyle().Foreground(th.Bg).Background(bg).Bold(true).Padding(0, 1).Render(text)
}

// SoftPill is a pill on a tint of its colour, for information that should not shout.
func (th Theme) SoftPill(text string, fg color.Color) string {
	return lipgloss.NewStyle().Foreground(fg).Background(th.Tint(fg, 0.22)).Padding(0, 1).Render(text)
}

// ModeColor is the colour a session mode is shown in, everywhere it is shown.
func (th Theme) ModeColor(mode string) color.Color {
	switch mode {
	case "plan":
		return th.Secondary
	case "auto":
		return th.Warning
	case "defender":
		return th.Error
	}
	return th.Primary
}
