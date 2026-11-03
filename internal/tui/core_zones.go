package tui

import (
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// Click targets are zones, marked where the thing is drawn, so a target cannot drift from what is
// on screen: mark wraps text in an invisible marker, and scanning the finished frame strips the
// markers and records where each zone landed. A layer the compositor places is a string of its
// own, so each layer has its own manager (the frame, the open dialog, the toasts), and a layer is
// scanned at its screen position, so its zones are in screen coordinates.
//
// The markers are BubbleZone's (ESC [ <n> z), which this replaces. Its scanner rebuilt the whole
// frame to remove each marker, a copy of the frame per target, which made scanning most of a
// redraw's time and garbage; this scans once, writing the frame out as it goes, and records zones
// at once rather than through a goroutine. Widths are measured as the renderer measures them, so a
// hyperlink's escape sequence counts as nothing, with no placeholder swapped in around the scan.

type zones struct {
	frame, dialog, toasts *zoneManager
}

func newZones() zones {
	return zones{frame: newZoneManager(), dialog: newZoneManager(), toasts: newZoneManager()}
}

// markerCounter numbers markers across every manager, so a marker of one is never another's.
var markerCounter atomic.Int64

// zoneManager is one layer's zones: the marker each id is drawn with, and where each landed in
// the last scan.
type zoneManager struct {
	mu    sync.RWMutex
	ids   map[string]string // id → marker
	rids  map[string]string // marker → id
	zones map[string]*zoneInfo
	open  map[string]*zoneInfo // zones whose start was seen this scan and not their end
}

func newZoneManager() *zoneManager {
	return &zoneManager{ids: map[string]string{}, rids: map[string]string{}, zones: map[string]*zoneInfo{}, open: map[string]*zoneInfo{}}
}

// zoneInfo is where a zone was drawn: its top left and bottom right cells, from 0.
type zoneInfo struct {
	StartX, StartY, EndX, EndY int
}

// IsZero reports a zone not drawn in the last scan.
func (z *zoneInfo) IsZero() bool { return z == nil }

// InBounds reports a mouse event inside the zone's box.
func (z *zoneInfo) InBounds(msg tea.MouseMsg) bool {
	if z == nil || z.StartX > z.EndX || z.StartY > z.EndY {
		return false
	}
	e := msg.Mouse()
	return e.X >= z.StartX && e.Y >= z.StartY && e.X <= z.EndX && e.Y <= z.EndY
}

// Pos is a mouse event relative to the zone's top left, or (-1, -1) outside it.
func (z *zoneInfo) Pos(msg tea.MouseMsg) (x, y int) {
	if !z.InBounds(msg) {
		return -1, -1
	}
	e := msg.Mouse()
	return e.X - z.StartX, e.Y - z.StartY
}

// Mark wraps text in the zone id's marker.
func (z *zoneManager) Mark(id, text string) string {
	if id == "" || text == "" {
		return text
	}
	z.mu.RLock()
	marker := z.ids[id]
	z.mu.RUnlock()
	if marker == "" {
		z.mu.Lock()
		if marker = z.ids[id]; marker == "" {
			marker = "\x1b[" + strconv.FormatInt(markerCounter.Add(1), 10) + "z"
			z.ids[id], z.rids[marker] = marker, id
		}
		z.mu.Unlock()
	}
	return marker + text + marker
}

// Get is where zone id was drawn in the last scan; nil when it was not.
func (z *zoneManager) Get(id string) *zoneInfo {
	z.mu.RLock()
	defer z.mu.RUnlock()
	return z.zones[id]
}

// scanOffset strips the markers from text and records its zones as if text were drawn with its
// top left at (dx, dy). The zones of the previous scan are replaced.
func (z *zoneManager) scanOffset(text string, dx, dy int) string {
	if strings.IndexByte(text, '\x1b') < 0 {
		z.mu.Lock()
		clear(z.zones)
		z.mu.Unlock()
		return text
	}
	var out strings.Builder
	out.Grow(len(text))
	z.mu.Lock()
	defer z.mu.Unlock()
	clear(z.zones)
	clear(z.open)
	// measured and width: the row's text is measured up to out[measured], width cells; each marker
	// measures only what came since the last one on its row.
	row, measured, width, copied := 0, 0, 0, 0
	for i := 0; i < len(text); i++ {
		switch text[i] {
		case '\n':
			row++
			measured, width = out.Len()+(i-copied)+1, 0
		case '\x1b':
			end, ok := markerEnd(text, i)
			if !ok {
				continue
			}
			out.WriteString(text[copied:i])
			copied = end
			id, known := z.rids[text[i:end]]
			if known {
				width += ansi.StringWidth(out.String()[measured:])
				measured = out.Len()
				x := width
				if zi := z.open[id]; zi != nil {
					zi.EndX, zi.EndY = x-1+dx, row+dy
					z.zones[id] = zi
					delete(z.open, id)
				} else {
					z.open[id] = &zoneInfo{StartX: x + dx, StartY: row + dy}
				}
			}
			i = end - 1
		}
	}
	out.WriteString(text[copied:])
	return out.String()
}

// markerEnd is the end of a zone marker starting at i (ESC [ digits z), if one starts there.
func markerEnd(text string, i int) (int, bool) {
	j := i + 2
	if j > len(text) || text[i+1] != '[' {
		return 0, false
	}
	digits := j
	for j < len(text) && text[j] >= '0' && text[j] <= '9' {
		j++
	}
	if j == digits || j >= len(text) || text[j] != 'z' {
		return 0, false
	}
	return j + 1, true
}

// scanAt registers the zones marked in block as if it were drawn at (x, y), and returns block with
// the markers removed, ready to be placed there.
func scanAt(m *zoneManager, block string, x, y int) string {
	return m.scanOffset(block, max(x, 0), max(y, 0))
}

// scan registers the zones of a whole frame, drawn from the top left.
func scan(m *zoneManager, text string) string { return m.scanOffset(text, 0, 0) }

// mark is m.Mark when there is a manager, and the text itself when there is not (the pager draws
// transcript blocks without click targets).
func mark(m *zoneManager, id, text string) string {
	if m == nil {
		return text
	}
	return m.Mark(id, text)
}
