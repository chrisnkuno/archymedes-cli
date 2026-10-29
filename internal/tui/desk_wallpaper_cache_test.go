package tui

import (
	"fmt"
	"image"
	"strings"
	"testing"

	"charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// frameOf is a synthetic frame of width-ish rows, some blank, one of them varied by n.
func frameOf(width, height, n int) string {
	rows := make([]string, height)
	for y := range rows {
		switch {
		case y == 0:
			rows[y] = strings.Repeat("─", width) // a top bar
		case y%4 == 0:
			rows[y] = fmt.Sprintf("row %d of the transcript, with some words", y)
		case y == height-1:
			rows[y] = fmt.Sprintf("> a line being edited %d", n) // the one that changes
		}
	}
	return strings.Join(rows, "\n")
}

// freshUnderlay composites a frame on a model that has never seen it, so its row cache is empty:
// the ground truth a cached composite must match exactly.
func freshUnderlay(t *testing.T, width, height int, content string, glass image.Rectangle) string {
	m := wallpaperModel(t, width, height)
	m.glass = glass
	return m.underlay(content, width, height)
}

// TestTheRowCacheNeverServesAStaleRow is the per-row cache's safety net: a sequence of frames, each
// reusing cached rows, must come out byte-for-byte the same as composing each frame from scratch.
func TestTheRowCacheNeverServesAStaleRow(t *testing.T) {
	const w, h = 120, 36
	m := wallpaperModel(t, w, h)
	for n := range 6 {
		content := frameOf(w, h, n)
		m.underIn = "" // defeat the whole-frame cache so the row cache is what is exercised
		got := m.underlay(content, w, h)
		want := freshUnderlay(t, w, h, content, image.Rectangle{})
		if got != want {
			t.Fatalf("frame %d: cached composite differs from a fresh one", n)
		}
	}
}

// TestTheRowCacheIsRebuiltWhenTheFrameChangesShape covers the invalidations: a window's glass
// appearing, and a resize. Each must drop the cache rather than reuse rows laid for the old shape.
func TestTheRowCacheIsRebuiltWhenTheFrameChangesShape(t *testing.T) {
	const w, h = 120, 36
	m := wallpaperModel(t, w, h)
	content := frameOf(w, h, 1)
	m.underIn = ""
	m.underlay(content, w, h) // fills the cache with no glass

	glass := image.Rect(10, 5, 60, 25)
	m.glass = glass
	m.underIn = ""
	got := m.underlay(content, w, h)
	if want := freshUnderlay(t, w, h, content, glass); got != want {
		t.Fatal("a window's glass did not invalidate the row cache")
	}

	m.Update(tea.WindowSizeMsg{Width: 90, Height: 30})
	narrow := frameOf(90, 30, 2)
	m.glass, m.underIn = image.Rectangle{}, ""
	got = m.underlay(narrow, 90, 30)
	if want := freshUnderlay(t, 90, 30, narrow, image.Rectangle{}); got != want {
		t.Fatal("a resize did not invalidate the row cache")
	}
}

// TestTheRowCacheHoldsOnAVeryLargeScreen checks a big terminal composes correctly (and, implicitly,
// without pathological behaviour) — the wallpaper suite's largest fixed size is smaller.
func TestTheRowCacheHoldsOnAVeryLargeScreen(t *testing.T) {
	const w, h = 320, 90
	m := wallpaperModel(t, w, h)
	content := frameOf(w, h, 1)
	m.underIn = ""
	if got, want := m.underlay(content, w, h), freshUnderlay(t, w, h, content, image.Rectangle{}); got != want {
		t.Fatal("a large screen composited differently cached than fresh")
	}
}

// TestWallpaperOffIsUntouched: with the photo off, underlay returns the frame unchanged and cheaply.
func TestWallpaperOffIsUntouched(t *testing.T) {
	m := wallpaperModel(t, 100, 30)
	m.opts.NoWallpaper = true
	m.wall, m.wallKey = nil, "" // drop the built grid so wallpaperOff takes effect
	content := frameOf(100, 30, 1)
	if got := m.underlay(content, 100, 30); got != content {
		t.Fatal("with the wallpaper off, the frame should pass through untouched")
	}
}

// TestAnAgentBatchAppliesEveryMessageInOrder covers the streaming coalescing: a batch of chunks is
// applied in order, and a turn's end in the same batch still ends the turn.
func TestAnAgentBatchAppliesEveryMessageInOrder(t *testing.T) {
	m, _ := newTestModel(t)
	typeText(m, "do it")
	press(m, tea.KeyEnter, 0)
	if m.phase != busy {
		t.Fatal("the turn did not start")
	}
	m.Update(agentBatch{msgs: []any{
		acp.TextChunk{Text: "one "},
		acp.TextChunk{Text: "two "},
		acp.TextChunk{Text: "three"},
	}})
	if s := screen(m); !strings.Contains(s, "one two three") {
		t.Fatalf("the batch's chunks were not all applied in order:\n%s", s)
	}
	m.Update(agentBatch{msgs: []any{acp.TextChunk{Text: " done"}, acp.TurnEnded{StopReason: "end_turn"}}})
	if m.phase == busy {
		t.Fatal("a turn's end in the batch did not finish the turn")
	}
}
