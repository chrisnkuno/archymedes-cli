package tui

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// The interface's own speed: what a keystroke, a streamed chunk and a redraw cost with a long
// session on screen. Run with `go test -bench . -run xxx ./internal/tui` (or `bun run bench:speed:go`).

func longSession(b *testing.B, turns int) *Model {
	b.Helper()
	m, _ := newTestModel(&testing.T{})
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	for i := range turns {
		m.tr.items = append(m.tr.items, &userItem{text: fmt.Sprintf("please change the thing number %d and run the tests", i)})
		a := &assistantItem{}
		a.append(fmt.Sprintf("Sure — here is what I will do for %d:\n\n- read the file\n- edit it\n\n```go\nfunc f%d() int { return %d }\n```\n\nDone.", i, i, i))
		m.tr.items = append(m.tr.items, a, &toolItem{name: "run_command", args: map[string]any{"command": "go test ./..."}, done: true, result: strings.Repeat("ok  \tpkg\t0.01s\n", 6)})
	}
	return m
}

// A redraw with 300 turns in the transcript: cached item rendering should make this independent of
// history length.
func BenchmarkViewLongTranscript(b *testing.B) {
	m := longSession(b, 300)
	m.View()
	b.ResetTimer()
	for range b.N {
		m.View()
	}
}

// Typing: one key into the composer, then the redraw it causes.
func BenchmarkKeystrokeWithLongTranscript(b *testing.B) {
	m := longSession(b, 300)
	m.View()
	b.ResetTimer()
	for i := range b.N {
		m.Update(tea.KeyPressMsg{Code: rune('a' + i%26), Text: string(rune('a' + i%26))})
		m.View()
	}
}

// Streaming: a chunk of reply text arrives and the frame is redrawn, as it does per network chunk.
func BenchmarkStreamedChunk(b *testing.B) {
	m := longSession(b, 100)
	a := &assistantItem{open: true}
	m.tr.items = append(m.tr.items, a)
	m.View()
	b.ResetTimer()
	for range b.N {
		a.append("another few words of the reply ")
		m.View()
	}
}

// The same redraw on a small transcript, to show how much history costs.
func BenchmarkViewShortTranscript(b *testing.B) {
	m := longSession(b, 3)
	m.View()
	b.ResetTimer()
	for range b.N {
		m.View()
	}
}

// A redraw of a 200×60 home screen with the wallpaper under it: the photo laid cell by cell.
func BenchmarkViewWithWallpaper(b *testing.B) {
	m, _ := newTestModel(&testing.T{})
	m.opts.NoWallpaper = false
	m.Update(tea.WindowSizeMsg{Width: 200, Height: 60})
	m.View()
	b.ResetTimer()
	for i := range b.N {
		m.angle = float64(i) // the mark turns: every frame is new
		m.View()
	}
}
