package tui

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// wgl4Symbols are WGL4's symbols beyond Latin-1, Greek and Cyrillic (which it carries whole enough
// for Friday's purposes): punctuation, arrows, maths, the box drawing and blocks, the shapes and
// the dingbats every core Windows font and the Linux console draw.
const wgl4Symbols = "‐–—―‗‘’‚“”„†‡•…‰′″‹›‼‾⁄ⁿ₣₤₧€℅ℓ№™Ω℮⅛⅜⅝⅞←↑→↓↔↕↨∂∆∏∑−∕∙√∞∟∩∫≈≠≡≤≥⌂⌐⌠⌡" +
	"─│┌┐└┘├┤┬┴┼═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬▀▄█▌▐░▒▓■□▪▫▬▲►▼◄◊○●◘◙◦☺☻☼♀♂♠♣♥♦♪♫"

func inWGL4(r rune) bool {
	return r < 0x100 || unicode.Is(unicode.Greek, r) || unicode.Is(unicode.Cyrillic, r) || strings.ContainsRune(wgl4Symbols, r)
}

// TestEverySymbolFridayDrawsHasAStandIn is the guard: a symbol added to the interface that WGL4
// lacks must come with its stand-in in safeGlyph, or the classic console shows a box.
func TestEverySymbolFridayDrawsHasAStandIn(t *testing.T) {
	literal := regexp.MustCompile("\"(?:[^\"\\\\\\n]|\\\\.)*\"|`[^`]*`|'(?:[^'\\\\]|\\\\.)'")
	for _, dir := range []string{".", "../render", "../theme"} {
		files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			src, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			for _, lit := range literal.FindAllString(string(src), -1) {
				for _, r := range lit {
					if _, ok := safeGlyph[r]; !ok && !inWGL4(r) {
						t.Errorf("%s draws %q (U+%04X), which WGL4 lacks: give it a one-column stand-in in safeGlyph", f, r, r)
					}
				}
			}
		}
	}
}

func TestStandInsAreWGL4AndTheSameWidth(t *testing.T) {
	for r, s := range safeGlyph {
		for _, c := range s {
			if !inWGL4(c) {
				t.Errorf("%q stands in for %q but is not in WGL4", s, r)
			}
		}
		if ansi.StringWidth(s) != ansi.StringWidth(string(r)) {
			t.Errorf("%q (%d columns) stands in for %q (%d): a frame would shift", s, ansi.StringWidth(s), r, ansi.StringWidth(string(r)))
		}
	}
	frame := "\x1b[38;2;1;2;3m╭─ ✓ done ⎿ ◆ ⠹\x1b[0m"
	if got := safeReplacer.Replace(frame); got != "\x1b[38;2;1;2;3m┌─ √ done └ ♦ |\x1b[0m" {
		t.Fatalf("a frame redrawn from WGL4, escapes untouched: %q", got)
	}
}

func TestSafeGlyphsFollowWhatTheTerminalCanDraw(t *testing.T) {
	for _, c := range []struct {
		name string
		goos string
		env  map[string]string
		safe bool
	}{
		{"linux terminal", "linux", map[string]string{"TERM": "xterm-256color"}, false},
		{"linux text console", "linux", map[string]string{"TERM": "linux"}, true},
		{"macOS", "darwin", map[string]string{"TERM": "xterm-256color", "TERM_PROGRAM": "Apple_Terminal"}, false},
		{"Windows Terminal", "windows", map[string]string{"WT_SESSION": "1"}, false},
		{"VS Code on Windows", "windows", map[string]string{"TERM_PROGRAM": "vscode"}, false},
		{"Git Bash (mintty)", "windows", map[string]string{"TERM": "xterm-256color"}, false},
		{"classic Windows console", "windows", map[string]string{}, true},
		{"asked for full", "windows", map[string]string{"ARCHYMEDES_GLYPHS": "full"}, false},
		{"asked for safe", "linux", map[string]string{"ARCHYMEDES_GLYPHS": "safe", "TERM": "xterm"}, true},
	} {
		if got := safeGlyphs(func(k string) string { return c.env[k] }, c.goos); got != c.safe {
			t.Errorf("%s: safe = %v, want %v", c.name, got, c.safe)
		}
	}
}

func TestASafeTerminalGetsOnlyWGL4OnScreen(t *testing.T) {
	m := railModel(t, 160)
	m.safe = true
	m.phase = busy
	startSubagent(m, "d1", 3)
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "run_command", Arguments: map[string]any{"command": "go test ./..."}}))
	screens := map[string]string{"chat": m.View().Content}
	m.Update(tea.KeyPressMsg{Code: tea.KeyRight})
	screens["inspector"] = m.View().Content
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m.overlay = newNewHelperDialog(m, acp.CommandResult{Items: []acp.CommandItem{{Text: "explore", Status: "read-only", Detail: "find things"}}})
	screens["picker"] = m.View().Content
	for name, screen := range screens {
		for _, r := range ansi.Strip(screen) {
			if !inWGL4(r) {
				t.Errorf("%s: %q (U+%04X) reached a WGL4-only terminal", name, r, r)
				break
			}
		}
	}
}
