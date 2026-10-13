package tui

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func pagerModel(t *testing.T) *Model {
	t.Helper()
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 20})
	for i := 1; i <= 60; i++ {
		text := fmt.Sprintf("line %02d of the session", i)
		if i%20 == 0 {
			text += " mentions the Needle here"
		}
		m.notice(noticeInfo, text)
	}
	return m
}

func TestPagerSearchesTheWholeSessionAndSteps(t *testing.T) {
	m := pagerModel(t)
	submitCommand(m, "/find needle")
	p, ok := m.activeWindow().(*pager)
	if !ok {
		t.Fatal("/find opens the pager")
	}
	if len(p.matches) != 3 || p.current != 2 {
		t.Fatalf("matches=%v current=%d", p.matches, p.current)
	}
	s := screen(m)
	if !strings.Contains(s, "3 of 3") || !strings.Contains(s, "line 60 of the session mentions the Needle") {
		t.Fatalf("newest match not shown:\n%s", s)
	}
	press(m, 'n', 0)
	if p.current != 0 || !strings.Contains(screen(m), "1 of 3") || !strings.Contains(screen(m), "line 20") {
		t.Fatalf("n wraps to the first match:\n%s", screen(m))
	}
	press(m, 'N', 0)
	if p.current != 2 {
		t.Fatal("N steps back")
	}
	// Line numbers in the gutter.
	if !strings.Contains(s, " │ ") {
		t.Fatalf("no gutter:\n%s", s)
	}
	press(m, tea.KeyEscape, 0)
	if m.activeWindow() == nil || p.query != "" {
		t.Fatal("esc clears the search first")
	}
	press(m, tea.KeyEscape, 0)
	if m.activeWindow() != nil {
		t.Fatal("then closes")
	}
}

func TestPagerSearchIsTypedInPlaceAndCopiesPlainText(t *testing.T) {
	m := pagerModel(t)
	press(m, 'f', tea.ModCtrl)
	p := m.activeWindow().(*pager)
	if !p.typing {
		t.Fatal("ctrl+f opens straight into search")
	}
	typeText(m, "line 07")
	press(m, tea.KeyEnter, 0)
	if len(p.matches) != 1 || p.typing {
		t.Fatalf("matches=%v", p.matches)
	}
	if cmd := press(m, 'c', 0); cmd == nil {
		t.Fatal("c copies through the terminal clipboard")
	}
	if strings.Contains(strings.Join(p.plain, "\n"), "\x1b") {
		t.Fatal("copied text carries escapes")
	}
}

func TestPagerFitsEverySize(t *testing.T) {
	m := pagerModel(t)
	submitCommand(m, "/find needle")
	for _, size := range [][2]int{{100, 30}, {80, 20}, {40, 10}, {14, 3}, {200, 60}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		assertFits(t, m, "pager")
	}
}

func TestMarkMatchesKeepsTheText(t *testing.T) {
	m, _ := newTestModel(t)
	got := markMatches("A needle and a NEEDLE", "needle", m.th.Body, m.th.Key)
	if ansi.Strip(got) != "A needle and a NEEDLE" {
		t.Fatalf("%q", ansi.Strip(got))
	}
}
