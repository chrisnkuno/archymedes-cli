package tui

import (
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

// The home screen's motion stops when the terminal loses focus or nothing was typed for a minute,
// and starts again at the next key, click or return of focus.
func TestHomeMotionRestsWhileNobodyLooks(t *testing.T) {
	m, _ := newTestModel(t)
	if !m.landingVisible() {
		t.Fatal("not on the home screen")
	}
	m.animated = true
	angle := m.angle
	if _, cmd := m.Update(animTickMsg{}); cmd == nil || m.angle == angle {
		t.Fatal("an awake home screen does not turn")
	}

	m.Update(tea.BlurMsg{})
	angle = m.angle
	if _, cmd := m.Update(animTickMsg{}); cmd != nil || m.animated || m.angle != angle {
		t.Fatalf("blurred, it kept moving (animated %v)", m.animated)
	}
	if _, cmd := m.Update(tea.FocusMsg{}); cmd == nil || !m.animated {
		t.Fatal("focus did not wake it")
	}

	m.lastInput = time.Now().Add(-restAfter - time.Second)
	if _, cmd := m.Update(animTickMsg{}); cmd != nil || m.animated {
		t.Fatal("a minute without input, it kept moving")
	}
	if _, cmd := m.Update(tea.KeyPressMsg{Code: 'a', Text: "a"}); cmd == nil || !m.animated {
		t.Fatal("a key did not wake it")
	}
	m.lastInput = time.Now().Add(-restAfter - time.Second)
	m.Update(animTickMsg{})
	if m.Update(tea.MouseClickMsg{X: 1, Y: 1}); !m.animated {
		t.Fatal("a click did not wake it")
	}
}
