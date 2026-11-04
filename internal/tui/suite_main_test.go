package tui

import (
	"os"
	"testing"
)

// TestMain pins what the host would otherwise decide. The interface's language is English, so a test
// asserting on its words passes on a machine whose locale is Japanese or Spanish; a test about another
// language sets it itself. The glyph set is the full one: left to detection, a machine with none of
// the terminal markers (GitHub's Windows runner has none) draws stand-ins for ★ ⎿ ⋯ ◇ and the rest, and
// every test asserting on those symbols fails there while passing on a developer's Windows Terminal.
// The tests of the detection itself and of the stand-ins pass their own environment or set the flag.
func TestMain(m *testing.M) {
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG", "ARCHYMEDES_LANGUAGE"} {
		os.Unsetenv(name)
	}
	os.Setenv("ARCHYMEDES_GLYPHS", "full")
	os.Exit(m.Run())
}
