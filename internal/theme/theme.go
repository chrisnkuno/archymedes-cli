// Package theme is colour as named roles, the only place the Go front end names a colour.
//
// The built-in palettes are the same tokens as packages/archymedes-cli/src/theme/theme.ts, so a
// theme name means the same thing in both front ends while they coexist.
package theme

import (
	"fmt"
	"image/color"
	"sort"
	"strings"

	"charm.land/lipgloss/v2"
)

// Tokens are a theme's roles, as hex strings or ANSI colour names.
type Tokens struct {
	Primary, Secondary, Accent       string
	Bg, Surface, Text, TextMuted     string
	Success, Warning, Error          string
	Border, BorderColor, BorderFocus string
}

// DefaultName is the theme used when none is chosen (`DEFAULT_THEME_NAME`).
const DefaultName = "archymedes-blue"

var builtins = map[string]Tokens{
	// Solarized Dark with an Archymedes-blue line: the default.
	"archymedes-blue": {"#268bd2", "#2aa198", "#b58900", "#002b36", "#073642", "#93a1a1", "#657b83", "#859900", "#cb4b16", "#dc322f", "round", "#586e75", "#268bd2"},
	"archymedes":      {"#e7bb78", "#b9c59a", "#e5a58c", "#191815", "#25231e", "#f2ecdf", "#aaa18f", "#b5cc96", "#efc778", "#f29686", "single", "#736956", "#e7bb78"},
	"blueprint":       {"#7cc5ff", "#9fb4e8", "#ffcf6b", "#0a1524", "#122135", "#e8eefb", "#6f89b0", "#79dfa6", "#ffcf6b", "#ff8f7a", "round", "#24406a", "#7cc5ff"},
	"parchment":       {"#2f5fbf", "#5a4a86", "#9a6a00", "#faf6ec", "#f1eadd", "#1b1a16", "#6a6252", "#196a44", "#8a5300", "#b3243b", "round", "#d8cfb8", "#2f5fbf"},
	"chalkboard":      {"#9fe8d8", "#d8d0b0", "#ffe066", "#0d1a15", "#16271f", "#f2efe4", "#86987f", "#7ef2b0", "#ffd166", "#ff7a7a", "single", "#2c443a", "#ffe066"},
	"high-contrast":   {"brightCyan", "brightMagenta", "brightYellow", "black", "black", "brightWhite", "white", "brightGreen", "brightYellow", "brightRed", "single", "white", "brightCyan"},
	"rainbow":         {"#ff5f5f", "#5fd7ff", "#ffd75f", "#0c0c0c", "#161616", "#f2f2f2", "#9a9a9a", "#5fff87", "#ffaf5f", "#ff3b3b", "double", "#8a8a8a", "#d75fff"},
}

// Names lists the built-in themes, sorted.
func Names() []string {
	names := make([]string, 0, len(builtins))
	for name := range builtins {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Theme is a palette resolved to colours and the styles every view draws with.
type Theme struct {
	Name   string
	Tokens Tokens
	// Light is true for a theme drawn on a light ground (parchment), for renderers with two variants.
	Light                      bool
	Primary, Secondary, Accent color.Color
	Bg, Surface, Text, Muted   color.Color
	Success, Warning, Error    color.Color
	BorderColor, BorderFocus   color.Color
	Border                     lipgloss.Border

	// Ready-made styles; views use these rather than building their own colours.
	Body, Faint, Strong, Title, Key   lipgloss.Style
	OK, Warn, Bad, Highlight          lipgloss.Style
	UserGutter, AgentGutter, ToolName lipgloss.Style
	StatusBar, StatusKey              lipgloss.Style
}

// Load resolves a built-in theme by name; an unknown name falls back to the default and says so.
func Load(name string) (Theme, bool) {
	name = strings.TrimSpace(strings.ToLower(name))
	tokens, ok := builtins[name]
	if !ok {
		name, tokens = DefaultName, builtins[DefaultName]
	}
	return build(name, tokens), ok
}

func build(name string, t Tokens) Theme {
	th := Theme{
		Name: name, Tokens: t, Light: isLight(t.Bg), Primary: col(t.Primary), Secondary: col(t.Secondary), Accent: col(t.Accent),
		Bg: col(t.Bg), Surface: col(t.Surface), Text: col(t.Text), Muted: col(t.TextMuted),
		Success: col(t.Success), Warning: col(t.Warning), Error: col(t.Error),
		BorderColor: col(t.BorderColor), BorderFocus: col(t.BorderFocus), Border: border(t.Border),
	}
	base := lipgloss.NewStyle()
	th.Body = base.Foreground(th.Text)
	th.Faint = base.Foreground(th.Muted)
	th.Strong = base.Foreground(th.Text).Bold(true)
	th.Title = base.Foreground(th.Primary).Bold(true)
	th.Key = base.Foreground(th.Accent).Bold(true)
	th.OK = base.Foreground(th.Success)
	th.Warn = base.Foreground(th.Warning)
	th.Bad = base.Foreground(th.Error)
	th.Highlight = base.Foreground(th.Secondary)
	th.UserGutter = base.Foreground(th.Accent).Bold(true)
	th.AgentGutter = base.Foreground(th.Primary).Bold(true)
	th.ToolName = base.Foreground(th.Secondary).Bold(true)
	th.StatusBar = base.Foreground(th.Muted)
	th.StatusKey = base.Foreground(th.Text).Bold(true)
	return th
}

// ansiNames are the colour names the TSS themes may use instead of hex, as ANSI indices.
var ansiNames = map[string]string{
	"black": "0", "red": "1", "green": "2", "yellow": "3", "blue": "4", "magenta": "5", "cyan": "6", "white": "7",
	"brightBlack": "8", "brightRed": "9", "brightGreen": "10", "brightYellow": "11", "brightBlue": "12",
	"brightMagenta": "13", "brightCyan": "14", "brightWhite": "15",
}

func col(value string) color.Color {
	return lipgloss.Color(Spec(value))
}

// Spec is a token as a colour string other libraries accept: hex as is, a name as its ANSI index.
func Spec(token string) string {
	if index, ok := ansiNames[token]; ok {
		return index
	}
	return token
}

// isLight reads a hex ground's relative luminance; a named ground is one of the dark ANSI ones.
func isLight(bg string) bool {
	var r, g, b int
	if len(bg) != 7 || bg[0] != '#' {
		return false
	}
	if _, err := fmt.Sscanf(bg[1:], "%02x%02x%02x", &r, &g, &b); err != nil {
		return false
	}
	return 0.2126*float64(r)+0.7152*float64(g)+0.0722*float64(b) > 140
}

func border(name string) lipgloss.Border {
	switch name {
	case "single":
		return lipgloss.NormalBorder()
	case "double":
		return lipgloss.DoubleBorder()
	default:
		return lipgloss.RoundedBorder()
	}
}
