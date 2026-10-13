package tui

// transcript is the scrollable history: items stacked top to bottom, drawn from the bottom up.
//
// Each item's lines are cached against its version and the width, so a frame only re-renders
// what changed (normally the one streaming reply). Drawing walks back from the newest item and
// stops once the window is full, so cost follows the screen height, not the length of the session.
type transcript struct {
	items []item
	cache map[item]cached
	// scroll is how many lines the view sits above the newest line; 0 means following live output.
	scroll int
	// While scrolled back, the total height at the last draw: growth below the view (a streaming
	// reply, a new tool call) is added to scroll so the lines being read stay where they are.
	anchorTotal, anchorWidth int
}

type cached struct {
	width    int
	version  uint64
	expanded bool
	lines    []string
}

func newTranscript() *transcript {
	return &transcript{cache: map[item]cached{}}
}

func (t *transcript) add(it item) {
	t.items = append(t.items, it)
}

func (t *transcript) clear() {
	t.items, t.cache, t.scroll = nil, map[item]cached{}, 0
}

func (t *transcript) lines(it item, ctx renderCtx) []string {
	if ctx.width <= 0 {
		return nil
	}
	if c, ok := t.cache[it]; ok && c.width == ctx.width && c.version == it.version() && c.expanded == ctx.expanded {
		return c.lines
	}
	lines := it.render(ctx)
	t.cache[it] = cached{width: ctx.width, version: it.version(), expanded: ctx.expanded, lines: lines}
	return lines
}

// window returns exactly height lines (padding with blanks at the top), and clamps scroll to the
// history that exists.
func (t *transcript) window(ctx renderCtx, height int) []string {
	if height <= 0 {
		return nil
	}
	t.holdAnchor(ctx)
	need := height + t.scroll
	var rows []string // newest last, built in reverse then flipped
	for i := len(t.items) - 1; i >= 0 && len(rows) < need; i-- {
		lines := t.lines(t.items[i], ctx)
		if len(lines) == 0 {
			continue
		}
		if len(rows) > 0 {
			rows = append(rows, "") // one blank line between blocks
		}
		for j := len(lines) - 1; j >= 0; j-- {
			rows = append(rows, lines[j])
		}
	}
	// Clamp: scrolling cannot go above the first line.
	if maxScroll := max(len(rows)-height, 0); t.scroll > maxScroll && len(rows) < need {
		t.scroll = maxScroll
	}
	start := t.scroll
	end := min(start+height, len(rows))
	out := make([]string, 0, height)
	for i := end - 1; i >= start; i-- {
		out = append(out, rows[i])
	}
	for len(out) < height {
		out = append([]string{""}, out...)
	}
	return out
}

func (t *transcript) holdAnchor(ctx renderCtx) {
	if t.scroll == 0 {
		t.anchorTotal = 0
		return
	}
	total := 0
	for _, it := range t.items {
		if n := len(t.lines(it, ctx)); n > 0 {
			total += n + 1
		}
	}
	if t.anchorTotal > 0 && t.anchorWidth == ctx.width && total > t.anchorTotal {
		t.scroll += total - t.anchorTotal
	}
	t.anchorTotal, t.anchorWidth = total, ctx.width
}

// allLines is the whole transcript as drawn, blocks separated by a blank line, oldest first — for
// the pager, which reads all of it rather than a window.
func (t *transcript) allLines(ctx renderCtx) []string {
	var out []string
	for _, it := range t.items {
		lines := t.lines(it, ctx)
		if len(lines) == 0 {
			continue
		}
		if len(out) > 0 {
			out = append(out, "")
		}
		out = append(out, lines...)
	}
	return out
}

func (t *transcript) scrollBy(lines int) {
	t.scroll = max(t.scroll+lines, 0)
}

func (t *transcript) toTop()          { t.scroll = 1 << 30 } // clamped on the next draw
func (t *transcript) toBottom()       { t.scroll = 0 }
func (t *transcript) following() bool { return t.scroll == 0 }
