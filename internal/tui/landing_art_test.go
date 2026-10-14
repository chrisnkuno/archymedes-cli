package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func landingAt(t *testing.T, w, h int, angle float64) (*Model, string) {
	t.Helper()
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	m.angle = angle
	return m, screen(m)
}

func TestNothingOnTheLandingScreenIsClipped(t *testing.T) {
	for _, size := range [][2]int{{80, 24}, {96, 28}, {100, 30}, {120, 32}, {150, 34}} {
		_, s := landingAt(t, size[0], size[1], 0.7)
		for _, want := range []string{"a coding agent that shows its work", "ask anything", "find anything", "what changed"} {
			if !strings.Contains(s, want) {
				t.Errorf("%dx%d lacks %q:\n%s", size[0], size[1], want, s)
			}
		}
	}
}

func TestTheLandingScreenFitsEverySizeAndEveryAngle(t *testing.T) {
	for _, w := range []int{20, 31, 46, 60, 79, 95, 96, 97, 110, 130, 180} {
		for _, h := range []int{6, 12, 18, 24, 29, 31, 40} {
			for _, angle := range []float64{0, 1.1, 2.3, 4.0} {
				m, _ := landingAt(t, w, h, angle)
				assertFits(t, m, "landing")
			}
		}
	}
}
