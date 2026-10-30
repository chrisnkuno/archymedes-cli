package tui

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func scriptCard() *toolItem {
	var out []string
	for i := 1; i <= 20; i++ {
		out = append(out, fmt.Sprintf("row %02d", i))
	}
	return &toolItem{id: "c1", name: "run_command", done: true, result: strings.Join(out, "\n"),
		args: map[string]any{"command": "set -e\nfor i in $(seq 1 20); do\n  echo \"row $i\"\ndone", "timeout": 30}}
}

func TestAFoldedCardOffersToShowItsCommandAndOutput(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 50})
	card := scriptCard()
	m.tr.add(card)
	s := screen(m)
	if !strings.Contains(s, "▸ show all · the full command · 20 lines of output") {
		t.Fatalf("the folded card names what it hides:\n%s", s)
	}
	if strings.Contains(s, "row 20") || strings.Contains(s, "$ set -e") {
		t.Fatalf("folded, only the header line of the script shows, and no output:\n%s", s)
	}
	click(m, 4, rowOf(t, m, "▸ show all"))
	s = screen(m)
	if !card.open || m.tr.sel != card {
		t.Fatal("a click on the button opens the card and selects it")
	}
	for _, want := range []string{"$ set -e", "for i in $(seq 1 20); do", "timeout: 30", "row 20", "▾ fold"} {
		if !strings.Contains(s, want) {
			t.Fatalf("opened, the card shows %q:\n%s", want, s)
		}
	}
	click(m, 4, rowOf(t, m, "▾ fold"))
	if card.open || strings.Contains(screen(m), "row 20") {
		t.Fatalf("▾ fold folds it again:\n%s", screen(m))
	}
}

func TestACardWithNothingHiddenHasNoButton(t *testing.T) {
	m, _ := newTestModel(t)
	m.tr.add(&toolItem{id: "c1", name: "run_command", done: true, result: "", args: map[string]any{"command": "true"}})
	if s := screen(m); strings.Contains(s, "show all") {
		t.Fatalf("a short command with no output has nothing to open:\n%s", s)
	}
	m.expanded = true
	m.tr.add(scriptCard())
	if s := screen(m); strings.Contains(s, "show all") || strings.Contains(s, "▾ fold") {
		t.Fatalf("with ctrl+o every card is open, and no card has a button:\n%s", s)
	}
}

func TestTheReaderShowsTheWholeCall(t *testing.T) {
	card := scriptCard()
	text := toolInputText(card)
	if !strings.HasPrefix(text, "$ set -e\n  for i in") || !strings.HasSuffix(text, "timeout: 30") {
		t.Fatalf("input text:\n%s", text)
	}
}
