package render

import (
	"fmt"
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

// LooksLikeDiff is true for unified-diff text, which is drawn with added and removed lines coloured.
func LooksLikeDiff(body string) bool {
	return strings.Contains(body, "\n@@ ") || strings.HasPrefix(body, "@@ ") || strings.HasPrefix(body, "--- ") || strings.HasPrefix(body, "diff --git")
}

// Excerpt is up to maxLines of a tool's output, each clipped to width (maxLines <= 0: all of it),
// with a closing line saying how much was left out so nothing is hidden silently.
func Excerpt(th theme.Theme, body string, width, maxLines int) []string {
	body = strings.TrimRight(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	if body == "" {
		return nil
	}
	diff := LooksLikeDiff(body)
	lines := strings.Split(body, "\n")
	shown := lines
	if maxLines > 0 && len(lines) > maxLines {
		shown = lines[:maxLines]
	}
	out := make([]string, 0, len(shown)+1)
	for _, line := range shown {
		// Tool output is untrusted: strip its own escapes so it cannot move the cursor or restyle
		// the screen, then expand tabs so width math matches what the terminal draws.
		line = ansi.Truncate(strings.ReplaceAll(ansi.Strip(line), "\t", "    "), width, "…")
		out = append(out, styleOutputLine(th, line, diff, width))
	}
	if hidden := len(lines) - len(shown); hidden > 0 {
		out = append(out, th.Faint.Render(fmt.Sprintf("… %d more %s (ctrl+o to expand)", hidden, map[bool]string{true: "line", false: "lines"}[hidden == 1])))
	}
	return out
}

func styleOutputLine(th theme.Theme, line string, diff bool, width int) string {
	if !diff {
		return th.Faint.Render(line)
	}
	// Added and removed rows sit on a tint of their colour across the full width, the way a code
	// review shows them, so a change reads as a block rather than as a leading character.
	row := func(fg, tint color.Color) string {
		return lipgloss.NewStyle().Foreground(fg).Background(th.Tint(tint, 0.18)).Width(width).Render(line)
	}
	switch {
	case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
		return th.Strong.Render(line)
	case strings.HasPrefix(line, "+"):
		return row(th.Success, th.Success)
	case strings.HasPrefix(line, "-"):
		return row(th.Error, th.Error)
	case strings.HasPrefix(line, "@@"):
		return th.Highlight.Render(line)
	}
	return th.Faint.Render(line)
}
