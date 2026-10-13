package tui

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/render"
	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

// renderCtx is what every item draws with.
type renderCtx struct {
	th       theme.Theme
	md       *render.Markdown
	width    int
	expanded bool // ctrl+o: show tool output in full
}

// item is one block of the transcript. version changes whenever its content does, which is what
// lets the transcript keep each item's lines until then instead of re-rendering every frame.
type item interface {
	render(ctx renderCtx) []string
	version() uint64
}

// versioned is embedded by items that change after they are added.
type versioned struct{ v uint64 }

func (b *versioned) version() uint64 { return b.v }
func (b *versioned) touch()          { b.v++ }

// gutter prefixes the first line with mark and indents the rest to match, so a block reads as one.
func gutter(mark string, lines []string) []string {
	pad := strings.Repeat(" ", ansi.StringWidth(mark))
	for i := range lines {
		if i == 0 {
			lines[i] = mark + lines[i]
		} else {
			lines[i] = pad + lines[i]
		}
	}
	return lines
}

// --- the person's message ---

type userItem struct {
	versioned
	text string
}

func (u *userItem) render(ctx renderCtx) []string {
	// Behind a thick accent bar: the person's words are the one thing on screen nobody generated.
	box := lipgloss.NewStyle().
		Border(lipgloss.ThickBorder(), false, false, false, true).BorderForeground(ctx.th.Accent).
		PaddingLeft(1).Width(max(ctx.width, 10)).
		Foreground(ctx.th.Text).Bold(true)
	return strings.Split(box.Render(ansi.Wrap(u.text, max(ctx.width-2, 8), "")), "\n")
}

// --- the agent's reply, streamed ---

type assistantItem struct {
	versioned
	text strings.Builder
	// open is true while text may still arrive. Streaming markdown is re-rendered as it grows; a
	// closed item never changes again.
	open bool
}

func (a *assistantItem) append(text string) {
	a.text.WriteString(text)
	a.touch()
}

func (a *assistantItem) render(ctx renderCtx) []string {
	body := strings.TrimSpace(a.text.String())
	if body == "" {
		return nil
	}
	lines := strings.Split(ctx.md.Render(body, ctx.width-2), "\n")
	return gutter(ctx.th.AgentGutter.Render("● "), lines)
}

// --- one tool call and, once it arrives, its result ---

type toolItem struct {
	versioned
	id, name string
	args     map[string]any
	done     bool
	isError  bool
	result   string
	denied   bool
}

func (t *toolItem) finish(result string, isError bool) {
	t.done, t.result, t.isError = true, result, isError
	t.touch()
}

func (t *toolItem) render(ctx renderCtx) []string {
	th := ctx.th
	// A card: state mark, the tool as a soft pill, the one argument that matters, then what it
	// produced. Running calls are drawn hollow; the spinner in the status bar carries the motion,
	// so a cached card never needs repainting just to animate.
	mark, summary, accent := th.Faint.Render("◌"), th.Faint.Render("running"), th.Secondary
	switch {
	case t.done && t.isError:
		// The error itself is printed below the card; the header only says that it failed.
		mark, accent, summary = th.Bad.Render("✗"), th.Error, th.Bad.Render("failed")
	case t.done:
		mark = th.OK.Render("✓")
		summary = th.Faint.Render(render.SummarizeToolResult(t.name, t.result, false))
	}
	pill := th.SoftPill(strings.ReplaceAll(t.name, "_", " "), accent)
	room := max(ctx.width-ansi.StringWidth(pill)-ansi.StringWidth(summary)-6, 8)
	detail := render.TruncateMiddle(render.DescribeToolCall(t.name, t.args), room)
	head := mark + " " + pill
	if detail != "" {
		head += " " + th.Body.Render(detail)
	}
	head += th.Faint.Render(" · ") + summary
	lines := []string{ansi.Truncate(head, ctx.width, "…")}
	if t.done && showsOutput(t, ctx.expanded) {
		limit := 6
		if ctx.expanded {
			limit = 0
		}
		rule := lipgloss.NewStyle().Foreground(th.Tint(accent, 0.55)).Render("  │ ")
		for _, line := range render.Excerpt(th, t.result, ctx.width-4, limit) {
			lines = append(lines, rule+line)
		}
	}
	return lines
}

// showsOutput: failures and diffs are shown by default because they are what gets read; a
// successful read or listing is summarised, and ctrl+o shows everything.
func showsOutput(t *toolItem, expanded bool) bool {
	if expanded || t.isError {
		return true
	}
	return render.LooksLikeDiff(t.result) || t.name == "edit_file"
}

// --- a line the session itself says: retries, compactions, errors, help ---

type noticeKind int

const (
	noticeInfo noticeKind = iota
	noticeWarn
	noticeError
	noticeFaint
)

type noticeItem struct {
	versioned
	kind noticeKind
	text string
}

func (n *noticeItem) render(ctx renderCtx) []string {
	style, mark := ctx.th.Body, "  "
	switch n.kind {
	case noticeWarn:
		style, mark = ctx.th.Warn, "! "
	case noticeError:
		style, mark = ctx.th.Bad, "✗ "
	case noticeFaint:
		style = ctx.th.Faint
	}
	var lines []string
	for _, line := range strings.Split(ansi.Wrap(n.text, max(ctx.width-2, 10), ""), "\n") {
		lines = append(lines, style.Render(line))
	}
	return gutter(style.Render(mark), lines)
}

// --- the closing line of a turn ---

type turnItem struct {
	versioned
	stopReason string
	usage      usageTotals
	seconds    float64
}

func (t *turnItem) render(ctx renderCtx) []string {
	reason := map[string]string{
		"end_turn": "done", "cancelled": "cancelled", "refusal": "stopped", "max_turn_requests": "hit the step limit", "max_tokens": "hit the output limit",
	}[t.stopReason]
	if reason == "" {
		reason = t.stopReason
	}
	// A rule across the width with the turn's numbers set into it; the rule fades from the
	// primary colour into the ground, so the end of a turn is visible without being loud.
	label := fmt.Sprintf(" %s · %.1fs · %s in · %s out ", reason, t.seconds, compact(t.usage.input), compact(t.usage.output))
	label = ansi.Truncate(label, max(ctx.width-4, 1), "…")
	style := ctx.th.Faint
	from := ctx.th.Primary
	if t.stopReason != "end_turn" {
		style, from = ctx.th.Warn, ctx.th.Warning
	}
	lead := 2
	tail := max(ctx.width-lead-ansi.StringWidth(label), 0)
	rule := theme.Gradient(strings.Repeat("─", lead), from, from, false) + style.Render(label) +
		theme.Gradient(strings.Repeat("─", tail), from, ctx.th.Bg, false)
	return []string{rule}
}

// compact formats a token count the way the status bar does: 950, 12.3k, 1.2M.
func compact(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1_000)
	}
	return fmt.Sprint(n)
}
