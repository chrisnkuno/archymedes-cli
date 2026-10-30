package tui

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// A tool card folds what it was given and what it produced into one header line and a few rows.
// The fold button under it ("▸ show all · the full command · 42 lines of output") opens that one
// card in place: the whole command or script it ran, every argument, and all of its output; "▾
// fold" closes it again. A click on the button, enter on the selected card, or a second click on
// it all do the same; ctrl+o opens every card at once; space reads one in a pager.

// Bounds on an opened card: rows of its input before the rest is left to the pager (space), and
// how long a command may be before the header alone cannot show it.
const (
	maxInputRows   = 400
	shortCommand   = 60
	foldedOutput   = 6 // rows of output a folded card shows, when it shows any
	foldButtonMark = "fold:"
)

// foldZone is a card's fold button's click target.
func foldZone(t *toolItem) string { return foldButtonMark + t.id }

// foldable cards are those whose body this button opens; a sub-agent's card opens in the
// Inspector, and an edit's diff has its own "… more" row.
func foldable(t *toolItem) bool { return !delegationTools[t.name] && t.diff == "" }

// toolCommand is the shell command or script a call ran, if it ran one.
func toolCommand(t *toolItem) string {
	for _, k := range []string{"command", "script", "code"} {
		if v, ok := t.args[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimRight(v, "\n")
		}
	}
	return ""
}

// inputHidden reports whether the header cannot show all the call was given: a long or
// multi-line command, or arguments besides the one it names.
func inputHidden(t *toolItem) bool {
	if fileTools[t.name] {
		return false
	}
	if c := toolCommand(t); c != "" {
		return strings.Contains(c, "\n") || len(c) > shortCommand || len(otherArgs(t)) > 0
	}
	return len(t.args) > 1
}

// otherArgs are a call's arguments besides its command, in name order.
func otherArgs(t *toolItem) []string {
	var keys []string
	for k := range t.args {
		if (k == "command" || k == "script" || k == "code") && toolCommand(t) != "" {
			continue
		}
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// toolInputText is everything a call was given, as plain text: "$ " and its command, then each
// other argument as "name: value".
func toolInputText(t *toolItem) string {
	var b strings.Builder
	if c := toolCommand(t); c != "" {
		b.WriteString("$ " + strings.ReplaceAll(c, "\n", "\n  ") + "\n")
	}
	for _, k := range otherArgs(t) {
		v, ok := t.args[k].(string)
		if !ok {
			raw, _ := json.Marshal(t.args[k])
			v = string(raw)
		}
		b.WriteString(k + ": " + v + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// toolInputLines are an opened card's input rows, under a rule in the card's colour.
func toolInputLines(ctx renderCtx, t *toolItem, accent lipgloss.Style) []string {
	if !foldable(t) || !inputHidden(t) {
		return nil
	}
	rule := accent.Render("  ┆ ")
	width := max(ctx.width-4, 8)
	var lines []string
	for _, raw := range strings.Split(toolInputText(t), "\n") {
		style := ctx.th.Body
		if name, _, ok := strings.Cut(raw, ": "); ok && !strings.HasPrefix(raw, "$ ") && !strings.HasPrefix(raw, "  ") && t.args[name] != nil {
			style = ctx.th.Faint
		}
		for _, row := range strings.Split(ansi.Wrap(raw, width, ""), "\n") {
			lines = append(lines, rule+style.Render(row))
		}
	}
	if len(lines) > maxInputRows {
		more := len(lines) - maxInputRows
		lines = append(lines[:maxInputRows], rule+ctx.th.Faint.Render(fmt.Sprintf("… %s more · space reads it all", plural(more, "row"))))
	}
	return lines
}

// outputRows is how many lines a call's output has.
func outputRows(t *toolItem) int {
	out := strings.TrimRight(t.result, "\n")
	if !t.done || out == "" {
		return 0
	}
	return strings.Count(out, "\n") + 1
}

// foldButton is the row under a card that opens or folds it; none when there is nothing more to
// show, or when ctrl+o has opened every card.
func foldButton(ctx renderCtx, t *toolItem) []string {
	if !foldable(t) || ctx.expanded {
		return nil
	}
	th := ctx.th
	if t.open {
		return []string{mark(ctx.zones, foldZone(t), "  "+th.Key.Render("▾ fold"))}
	}
	rows := outputRows(t)
	hiddenOutput := rows > 0 && (!showsOutput(t, false) || rows > foldedOutput)
	var parts []string
	if inputHidden(t) {
		if toolCommand(t) != "" {
			parts = append(parts, "the full command")
		} else {
			parts = append(parts, "every argument")
		}
	}
	if hiddenOutput {
		parts = append(parts, plural(rows, "line")+" of output")
	}
	if len(parts) == 0 {
		return nil
	}
	label := th.Key.Render("▸ show all") + th.Faint.Render(" · "+strings.Join(parts, " · ")+" · enter")
	return []string{mark(ctx.zones, foldZone(t), "  "+ansi.Truncate(label, max(ctx.width-2, 8), "…"))}
}

// foldClick is a click on a card's fold button: that card opens or folds, and is selected.
func (m *Model) foldClick(msg tea.MouseClickMsg) bool {
	for _, it := range m.tr.items {
		if t, ok := it.(*toolItem); ok && foldable(t) && m.zones.frame.Get(foldZone(t)).InBounds(msg) {
			t.open = !t.open
			t.touch()
			m.tr.sel = t
			m.scrollToItem(t)
			return true
		}
	}
	return false
}
