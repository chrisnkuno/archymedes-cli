package tui

import (
	"os"
	"runtime"
	"strings"
)

// Glyphs every terminal can draw. Friday draws with symbols beyond ASCII (✓, ⎿, ◆, rounded
// corners, a braille spinner…). A terminal that falls back to other fonts for missing ones draws
// them all (Windows Terminal, VS Code, macOS and Linux terminals). One that cannot — the classic
// Windows console, the Linux text console, a terminal set to Consolas or Lucida Console — shows a
// box, or a glyph of the wrong width that shifts the rest of the line.
//
// So the whole frame, as it leaves Friday, can be redrawn from Windows Glyph List 4 (WGL4), the
// set every core Windows font and the Linux console carry: each symbol outside it is swapped for
// one of the same width that is in it. One table, one place, so nothing slips past it — borders,
// the spinner, markdown and the model's own text included. Whether it is used depends on what the
// terminal can draw, not on the operating system's name; ARCHYMEDES_GLYPHS=full or safe decides.

// safeGlyph is each symbol Friday draws that WGL4 lacks, and its stand-in from WGL4, as wide.
var safeGlyph = map[rune]string{
	// Lines and corners.
	'━': "═", '┃': "▌", '╭': "┌", '╮': "┐", '╰': "└", '╯': "┘", '┆': "¦", '▏': "│", '▁': "_", '⎿': "└",
	// Quadrants and shades of the desktop's drawn icons.
	'▗': "▄", '▖': "▄", '▝': "▀", '▘': "▀",
	// Marks.
	'✓': "√", '✗': "×", '✕': "×", '★': "*", '✦': "*", '⚑': "!", '✎': "»", '⟡': "◊",
	'◆': "♦", '◇': "◊", '◈': "♦", '◎': "○", '◐': "●", '◷': "○", '◌': "○",
	'▸': "►", '▾': "▼", '◂': "◄", '▢': "□", '◱': "□", '▣': "■", '▤': "≡", '▥': "■", '▦': "#",
	'⚙': "☼", '⌕': "?", '☰': "≡ ", '⇄': "↔", '↺': "«", '↻': "»", '⋯': "…",
	// The spinner (bubbles' MiniDot), as a turning line.
	'⠋': "-", '⠙': "\\", '⠹': "|", '⠸': "/", '⠼': "-", '⠴': "\\", '⠦': "|", '⠧': "/", '⠇': "-", '⠏': "\\",
}

// safeReplacer applies safeGlyph to a whole frame in one pass.
var safeReplacer = func() *strings.Replacer {
	pairs := make([]string, 0, 2*len(safeGlyph))
	for r, s := range safeGlyph {
		pairs = append(pairs, string(r), s)
	}
	return strings.NewReplacer(pairs...)
}()

// safeGlyphs reports whether to draw from WGL4 only: ARCHYMEDES_GLYPHS says (full or safe); else the
// Linux text console, and on Windows any console not known to draw every symbol.
func safeGlyphs(getenv func(string) string, goos string) bool {
	switch strings.ToLower(strings.TrimSpace(getenv("ARCHYMEDES_GLYPHS"))) {
	case "safe", "wgl4", "basic":
		return true
	case "full", "unicode":
		return false
	}
	if getenv("TERM") == "linux" {
		return true // the Linux text console: a 512-glyph font
	}
	if goos != "windows" {
		return false
	}
	// Windows: Windows Terminal, VS Code, ConEmu, WezTerm, Alacritty, mintty (Git Bash) and the like
	// all draw every symbol; the classic console host does not.
	for _, known := range []string{"WT_SESSION", "TERM_PROGRAM", "ConEmuANSI", "WEZTERM_EXECUTABLE", "ALACRITTY_LOG", "TERM"} {
		if getenv(known) != "" {
			return false
		}
	}
	return true
}

// glyphsFor is the frame as this terminal can draw it.
func (m *Model) glyphsFor(frame string) string {
	if !m.safe {
		return frame
	}
	return safeReplacer.Replace(frame)
}

// detectSafeGlyphs is safeGlyphs for this process.
func detectSafeGlyphs() bool { return safeGlyphs(os.Getenv, runtime.GOOS) }
