package tui

import (
	"os"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// Every scene draws something at any size, keeps to the window, and moves.
func TestShowcaseScenesFitAndMove(t *testing.T) {
	for _, size := range [][2]int{{120, 40}, {80, 24}, {40, 12}, {14, 6}} {
		m, _ := newTestModel(t)
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		m.openShowcase() // the clock is not followed: it re-arms while the app is in front
		s := m.activeWindow().(*showcaseApp)
		for i := range showcaseScenes {
			s.scene, s.t = i, 1.3
			first := s.view(m)
			lines := strings.Split(first, "\n")
			if len(lines) > m.windowHeight() {
				t.Fatalf("%dx%d scene %d: %d lines for %d rows", size[0], size[1], i, len(lines), m.windowHeight())
			}
			for _, line := range lines {
				if w := ansi.StringWidth(line); w > size[0] {
					t.Fatalf("%dx%d scene %d: a %d-wide line", size[0], size[1], i, w)
				}
			}
			if size[1] >= 24 {
				inked := strings.Count(ansi.Strip(first), " ")
				if inked == len(ansi.Strip(first)) {
					t.Fatalf("scene %d drew nothing", i)
				}
				s.t = 2.1
				if ansi.Strip(s.view(m)) == ansi.Strip(first) {
					t.Fatalf("scene %d does not move", i)
				}
			}
			if dir := os.Getenv("SHOWCASE_DUMP"); dir != "" && size[0] == 120 {
				_ = os.WriteFile(dir+"/scene"+string(rune('0'+i))+".txt", []byte(ansi.Strip(first)), 0o644)
			}
		}
	}
}

func TestShowcaseKeysAndClock(t *testing.T) {
	m, _ := newTestModel(t)
	cmd := m.openShowcase()
	if cmd == nil || m.openShowcase() != nil { // a second open focuses it and does not start a second clock
		t.Fatal("the clock should start once")
	}
	s := m.activeWindow().(*showcaseApp)
	press(m, tea.KeyRight, 0)
	press(m, tea.KeyLeft, 0)
	press(m, tea.KeyLeft, 0)
	if s.scene != len(showcaseScenes)-1 {
		t.Fatalf("scene = %d", s.scene)
	}
	typeText(m, " ")
	before := s.t
	m.Update(showcaseTickMsg{})
	if !s.paused || s.t != before {
		t.Fatal("space should pause the scene")
	}
	m.focus(0) // back to Chat: the clock lapses
	if _, next := m.Update(showcaseTickMsg{}); next != nil || s.ticking {
		t.Fatal("the clock should stop once the showcase is not in front")
	}
}
