package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// /review: the agent reads a change and reports findings without touching it (Codex's presets:
// the uncommitted work, a branch since its base, one commit, another branch against HEAD). The
// answer is a block in the transcript; the findings are also in the agent's conversation, so
// "fix 2" is a message it understands.

func (m *Model) cmdReview(arg string) tea.Cmd {
	what := "the uncommitted changes"
	if fields := strings.Fields(arg); len(fields) == 2 && (fields[0] == "base" || fields[0] == "commit" || fields[0] == "branch") {
		what = fields[0] + " " + fields[1]
	}
	return tea.Batch(m.toast(toastInfo, "Reviewing "+what+"…"), m.sessionCommand("review", arg))
}

// reviewItem is a review's findings, worst first, each with where it is.
type reviewItem struct {
	versioned
	result acp.CommandResult
}

func (r *reviewItem) render(ctx renderCtx) []string {
	th := ctx.th
	width := max(ctx.width, 8)
	head := th.Title.Render("review") + th.Faint.Render(" of "+r.result.Target)
	if len(r.result.Findings) == 0 {
		head += th.OK.Render("  no findings")
	} else {
		head += th.Faint.Render("  " + plural(len(r.result.Findings), "finding"))
	}
	lines := []string{ansi.Truncate(head, width, "…")}
	rule := lipgloss.NewStyle().Foreground(th.BorderColor).Render("│ ")
	for i, f := range r.result.Findings {
		badge := th.Faint
		switch f.Severity {
		case "high":
			badge = th.Bad
		case "medium":
			badge = th.Warn
		}
		where := f.File
		if f.Line > 0 {
			where = fmt.Sprintf("%s:%d", f.File, f.Line)
		}
		title := fmt.Sprintf("%d. ", i+1) + badge.Render(padRight(f.Severity, 7)) + th.Strong.Render(f.Title)
		lines = append(lines, rule+ansi.Truncate(title, width-2, "…"))
		lines = append(lines, rule+"   "+th.Key.Render(ansi.Truncate(where, max(width-5, 4), "…")))
		if f.Body != "" {
			for _, line := range strings.Split(ansi.Wrap(f.Body, max(width-5, 4), ""), "\n") {
				lines = append(lines, rule+"   "+th.Body.Render(line))
			}
		}
	}
	if r.result.Overall != "" {
		for _, line := range strings.Split(ansi.Wrap(r.result.Overall, max(width-2, 4), ""), "\n") {
			lines = append(lines, rule+th.Faint.Render(line))
		}
	}
	if len(r.result.Findings) > 0 {
		lines = append(lines, th.Faint.Render(ansi.Truncate(`ask for a fix by number: "fix 1"`, width, "")))
	}
	return lines
}
