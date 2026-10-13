package tui

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestScrollingGlidesToItsTargetWithoutOvershoot(t *testing.T) {
	m, _ := newTestModel(t)
	m.opts.Motion = true
	for i := 0; i < 80; i++ {
		m.notice(noticeInfo, "line")
	}
	screen(m)
	cmd := press(m, tea.KeyPgUp, 0)
	if cmd == nil || m.tr.scroll != 0 {
		t.Fatalf("page up starts a glide rather than jumping (scroll %d)", m.tr.scroll)
	}
	target := m.scroll.target
	prev, frames := 0, 0
	for m.scroll.active {
		m.Update(scrollTickMsg{})
		if m.tr.scroll < prev || m.tr.scroll > target {
			t.Fatalf("frame %d: %d after %d, target %d — not monotonic or overshot", frames, m.tr.scroll, prev, target)
		}
		prev = m.tr.scroll
		frames++
		if frames > 60 {
			t.Fatal("glide did not settle within a second")
		}
	}
	if m.tr.scroll != target || frames < 3 || frames > 30 {
		t.Fatalf("scroll %d target %d in %d frames", m.tr.scroll, target, frames)
	}
	// A second page while gliding retargets the same glide.
	press(m, tea.KeyPgUp, 0)
	if again := press(m, tea.KeyPgUp, 0); again != nil {
		t.Fatal("a retarget started a second tick chain")
	}
}

func TestWithoutMotionEveryMoveIsImmediate(t *testing.T) {
	m, _ := newTestModel(t)
	for i := 0; i < 80; i++ {
		m.notice(noticeInfo, "line")
	}
	if cmd := press(m, tea.KeyPgUp, 0); cmd != nil || m.tr.scroll == 0 {
		t.Fatalf("scroll %d", m.tr.scroll)
	}
}
