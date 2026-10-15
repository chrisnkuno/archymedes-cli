package tui

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/charmbracelet/x/ansi"
	zone "github.com/lrstanley/bubblezone/v2"
)

// Click targets are BubbleZone zones, marked where the thing is drawn, so a target cannot drift
// from what is on screen. Two properties of the library shape this file: each Scan clears the
// zones of earlier scans on the same manager, and a layer the compositor places is a string of its
// own. So each layer has its own manager — the frame, the open dialog, the toasts — and a layer is
// scanned at its screen position (padded with its offset), so its zones are in screen coordinates.
// Zones are stored by a worker goroutine just after Scan; a person's click comes long after.

type zones struct {
	frame, dialog, toasts *zone.Manager
}

func newZones() zones {
	return zones{frame: zone.New(), dialog: zone.New(), toasts: zone.New()}
}

// scanAt registers the zones marked in block as if it were drawn at (x, y), and returns block with
// the markers removed, ready to be placed there.
func scanAt(m *zone.Manager, block string, x, y int) string {
	lines := strings.Split(block, "\n")
	pad := strings.Repeat(" ", max(x, 0))
	padded := make([]string, 0, y+len(lines))
	for range max(y, 0) {
		padded = append(padded, "")
	}
	for _, line := range lines {
		padded = append(padded, pad+line)
	}
	stripped := strings.Split(scan(m, strings.Join(padded, "\n")), "\n")
	out := stripped[min(max(y, 0), len(stripped)):]
	for i, line := range out {
		out[i] = ansi.TruncateLeft(line, len(pad), "")
	}
	return strings.Join(out, "\n")
}

// oscSequence is an operating system command: a hyperlink (OSC 8), a title, a clipboard write.
var oscSequence = regexp.MustCompile("\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)")

// scan is m.Scan, made correct for text holding hyperlinks. BubbleZone measures a line by taking
// an escape sequence to end at its first letter, which is right for colours and wrong for OSC: a
// link's "\x1b]8;;https://…" would "end" at the h, and the rest of its URL count as visible
// width, moving every target after a link on its row. So each OSC sequence is swapped for a short
// CSI placeholder (zero width to the scanner) while it scans, and put back after.
func scan(m *zone.Manager, text string) string {
	var held []string
	text = oscSequence.ReplaceAllStringFunc(text, func(seq string) string {
		held = append(held, seq)
		return fmt.Sprintf("\x1b[65535;%dy", len(held)-1)
	})
	text = m.Scan(text)
	if len(held) == 0 {
		return text
	}
	return placeholder.ReplaceAllStringFunc(text, func(p string) string {
		var i int
		fmt.Sscanf(p, "\x1b[65535;%dy", &i)
		if i < 0 || i >= len(held) {
			return p
		}
		return held[i]
	})
}

var placeholder = regexp.MustCompile(`\x1b\[65535;\d+y`)

// mark is m.Mark when there is a manager, and the text itself when there is not (the pager draws
// transcript blocks without click targets).
func mark(m *zone.Manager, id, text string) string {
	if m == nil {
		return text
	}
	return m.Mark(id, text)
}
