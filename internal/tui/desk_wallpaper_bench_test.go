package tui

import (
	"fmt"
	"strings"
	"testing"
)

func benchFrame(m *Model) []string {
	rows := m.body(m.transcriptHeight())
	out := make([]string, m.height)
	for i := range out {
		if i < len(rows) {
			out[i] = rows[i]
		}
	}
	return out
}

// BenchmarkUnderlayFull is a whole changed frame — every row laid again (a resize, a theme change,
// a scroll). The floor the per-row cache cannot beat.
func BenchmarkUnderlayFull(b *testing.B) {
	m := wallpaperModel(b, 160, 48)
	m.tr.items = append(m.tr.items, &userItem{text: "explain this project"})
	rows := benchFrame(m)
	m.underlay(strings.Join(rows, "\n"), m.width, m.height) // warm the photo + grid
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		m.rowOut = nil // force every row to recomposite, as a wholesale change would
		m.underIn = ""
		m.underlay(strings.Join(rows, "\n"), m.width, m.height)
	}
}

// BenchmarkUnderlayTyping is one row changing while the rest stay — a keystroke in the composer, or
// a streaming line. The common case, and what decides whether the interface feels smooth.
func BenchmarkUnderlayTyping(b *testing.B) {
	m := wallpaperModel(b, 160, 48)
	m.tr.items = append(m.tr.items, &userItem{text: "explain this project"})
	rows := benchFrame(m)
	m.underlay(strings.Join(rows, "\n"), m.width, m.height) // warm
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rows[len(rows)-1] = fmt.Sprintf("> a line being typed %d", i) // one row differs each frame
		m.underIn = ""
		m.underlay(strings.Join(rows, "\n"), m.width, m.height)
	}
}
