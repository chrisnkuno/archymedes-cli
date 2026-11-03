package tui

// A reply is rendered as Markdown each time a chunk of it arrives. Rendering it whole made every
// chunk cost as much as the reply so far, so a long answer slowed down as it went. While it is
// written, the part up to its last finished block is rendered once and kept; each chunk renders
// only the block being written. A finished reply is rendered whole, once.

import (
	"regexp"
	"slices"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// settledSplit is where a reply still being written can be cut: the end of its last finished
// block, after which only the block being written changes. It is a blank line outside any code
// fence, not followed by indented text (an indented code block or a list item's continuation) or
// by a list item (a blank line between items continues the list), each of which would read
// differently cut off. 0 when there is no such place.
func settledSplit(text string) int {
	split, inFence, fence := 0, false, ""
	for pos := 0; pos < len(text); {
		end := strings.IndexByte(text[pos:], '\n')
		if end < 0 {
			break
		}
		line := text[pos : pos+end]
		next := pos + end + 1
		trimmed := strings.TrimLeft(line, " ")
		if len(line)-len(trimmed) <= 3 && (strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~")) {
			marker := trimmed[:3]
			switch {
			case !inFence:
				inFence, fence = true, marker
			case marker == fence:
				inFence = false
			}
		}
		if !inFence && strings.TrimSpace(line) == "" && next < len(text) && text[next] != ' ' && text[next] != '\t' && text[next] != '\n' && !listItem.MatchString(text[next:]) {
			split = next
		}
		pos = next
	}
	return split
}

// joinRendered sets two separately rendered parts of a reply one blank row apart, as the renderer
// sets two blocks of one document: blank rows at the seam are dropped, and one row as wide as the
// rendered lines goes between.
func joinRendered(head, tail []string) []string {
	for len(head) > 0 && strings.TrimSpace(ansi.Strip(head[len(head)-1])) == "" {
		head = head[:len(head)-1]
	}
	for len(tail) > 0 && strings.TrimSpace(ansi.Strip(tail[0])) == "" {
		tail = tail[1:]
	}
	// Always a new slice: head is kept between chunks, and the caller draws its gutter into what
	// this returns.
	if len(head) == 0 {
		return slices.Clone(tail)
	}
	if len(tail) == 0 {
		return slices.Clone(head)
	}
	width := 0
	for _, l := range head {
		width = max(width, ansi.StringWidth(l))
	}
	out := make([]string, 0, len(head)+1+len(tail))
	out = append(out, head...)
	out = append(out, strings.Repeat(" ", width))
	return append(out, tail...)
}

// listItem is a line starting a list item: "- ", "* ", "+ ", "3. ", "3) ".
var listItem = regexp.MustCompile(`^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)`)
