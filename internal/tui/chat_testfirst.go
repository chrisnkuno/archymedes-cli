package tui

import (
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// testFirstStep is one stage of building test first, as the stepper shows it.
type testFirstStep struct {
	label   string
	done    bool
	skipped bool // passed over: code changed before any test was seen failing
}

// testFirstSteps are the stages in order: tests written, seen failing, code, green, checked.
func testFirstSteps(s acp.TestFirstState) []testFirstStep {
	tests := "tests"
	if n := len(s.Tests); n > 0 {
		tests = plural(n, "test")
	}
	code := len(s.Code) > 0
	return []testFirstStep{
		{label: tests, done: len(s.Tests) > 0},
		{label: "red", done: s.Red, skipped: !s.Red && code},
		{label: "code", done: code},
		{label: "green", done: s.Green},
		{label: "checks", done: s.Checked},
	}
}

// testFirstStepper is the live line: ✓ for a stage reached, ● for the next one, ○ after it, and
// – for red when the code came before any failing test.
func testFirstStepper(th theme.Theme, s acp.TestFirstState) string {
	parts := []string{th.Faint.Render("test first")}
	next := true
	for _, step := range testFirstSteps(s) {
		switch {
		case step.done:
			parts = append(parts, th.OK.Render("✓")+" "+th.Body.Render(step.label))
		case step.skipped:
			parts = append(parts, th.Faint.Render("– "+step.label))
		case next:
			next = false
			parts = append(parts, lipgloss.NewStyle().Foreground(th.Accent).Render("●")+" "+th.Body.Render(step.label))
		default:
			parts = append(parts, th.Faint.Render("○ "+step.label))
		}
	}
	return strings.Join(parts, th.Faint.Render("  "))
}

// testFirstSummary is the turn's closing word on it: what was written, whether the tests went from
// red to green, and whether a static check passed. Missing stages are said, not left out.
func testFirstSummary(s acp.TestFirstState) string {
	parts := []string{"no tests"}
	if n := len(s.Tests); n > 0 {
		parts[0] = plural(n, "test file")
	}
	switch {
	case s.Red && s.Green:
		parts = append(parts, "red → green")
	case s.Green:
		parts = append(parts, "green")
	case len(s.Code) > 0 || len(s.Tests) > 0:
		parts = append(parts, "not green")
	}
	if s.Checked {
		parts = append(parts, "checked")
	} else if len(s.Code) > 0 {
		parts = append(parts, "unchecked")
	}
	return strings.Join(parts, " · ")
}
