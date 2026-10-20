package tui

import (
	"os"
	"testing"
)

// TestMain pins the interface's language to English, so a test asserting on its words passes on a
// machine whose locale is Japanese or Spanish. A test about another language sets it itself.
func TestMain(m *testing.M) {
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG", "ARCHYMEDES_LANGUAGE"} {
		os.Unsetenv(name)
	}
	os.Exit(m.Run())
}
