package tui

import (
	"time"
)

// The rail's CI: the pushed commit being followed (cmd_ci.go), each of its runs with its workflow,
// its status and how long it has run, as the background commands show theirs. ✓ when it passed,
// ✗ when it failed; the last commit followed stays until the next push.

// maxRailRuns is how many of a commit's runs the rail lists.
const maxRailRuns = 4

// railCIRows is the CI section: its title and a row per run; nil when nothing was pushed.
func (m *Model) railCIRows(inner int) []string {
	w := m.ci.watch
	if w == nil {
		return nil
	}
	th := m.th
	right := shortSHA(w.sha) + " · " + w.branch
	if w.stopped {
		right += " · not followed"
	}
	rows := []string{spread(th.Strong.Render("CI"), th.Faint.Render(right), inner)}
	if len(w.runs) == 0 {
		if w.following() {
			rows = append(rows, m.spin.View()+" "+th.Faint.Render("waiting for a run · "+elapsed(time.Since(w.started))))
		}
		return rows
	}
	now := time.Now()
	for i, r := range w.runs {
		if i == maxRailRuns {
			rows = append(rows, th.Faint.Render(" … "+plural(len(w.runs)-i, "more run")))
			break
		}
		glyph, state := m.spin.View(), th.Faint
		switch r.state() {
		case "failed":
			glyph, state = th.Bad.Render("✗"), th.Bad
		case "passed":
			glyph = th.OK.Render("✓")
		default:
			if r.done() || w.stopped {
				glyph = th.Faint.Render("–")
			}
		}
		rows = append(rows, glyph+" "+th.Body.Render(r.Workflow)+state.Render(" · "+r.state()+" · "+elapsed(r.took(now))))
	}
	return rows
}
