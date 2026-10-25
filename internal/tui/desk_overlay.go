package tui

import (
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// overlay is a modal over the transcript: it owns the keyboard until it closes. The approval
// dialog is not one of these; it is the agent's, and takes precedence over any of them.
type overlay interface {
	// handle returns true once the overlay should close.
	handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd)
	view(m *Model) string
}

// frame is the box every overlay is drawn in.
func frame(th theme.Theme, title, body string, width int) string {
	style := lipgloss.NewStyle().Border(th.Border).BorderForeground(th.BorderFocus).Padding(0, 1).Width(width)
	return style.Render(theme.Gradient(title, th.Primary, th.Secondary, true) + "\n" + body)
}

// overlayWidth is a box's text width: preferred, at least 16, and never more than the screen minus
// the box's two border columns.
func overlayWidth(m *Model, preferred int) int {
	return max(min(max(min(m.width-4, preferred), 16), m.width-2), 1)
}

// rankEntries keeps entries whose label holds the query's letters in order, best first: a prefix,
// then a substring, then a scattered match with the fewest gaps.
func rankEntries(entries []paletteEntry, query string) []paletteEntry {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return entries
	}
	type scored struct {
		e     paletteEntry
		score int
	}
	var out []scored
	for _, e := range entries {
		label := strings.ToLower(strings.TrimPrefix(e.label, "/"))
		switch {
		case strings.HasPrefix(label, query):
			out = append(out, scored{e, 0})
		case strings.Contains(label, query):
			out = append(out, scored{e, 1})
		default:
			if gaps, ok := subsequence(label, query); ok {
				out = append(out, scored{e, 2 + gaps})
			}
		}
	}
	slices.SortStableFunc(out, func(a, b scored) int { return a.score - b.score })
	result := make([]paletteEntry, len(out))
	for i, s := range out {
		result[i] = s.e
	}
	return result
}

func subsequence(text, query string) (gaps int, ok bool) {
	i, last := 0, -1
	for j, r := range text {
		if i < len(query) && r == rune(query[i]) {
			if last >= 0 && j != last+1 {
				gaps++
			}
			last, i = j, i+1
		}
	}
	return gaps, i == len(query)
}

// --- toasts: what the session says that is not part of the conversation ---

type toastKind int

const (
	toastInfo toastKind = iota
	toastWarn
)

type toast struct {
	id   int
	kind toastKind
	text string
}

type toastExpiredMsg struct{ id int }

const toastLife = 3 * time.Second

func (m *Model) toast(kind toastKind, text string) tea.Cmd {
	m.remember(kind, text)
	m.toastSeq++
	id := m.toastSeq
	m.toasts = append(m.toasts, toast{id: id, kind: kind, text: text})
	if len(m.toasts) > 3 {
		m.toasts = m.toasts[len(m.toasts)-3:]
	}
	return tea.Tick(toastLife, func(time.Time) tea.Msg { return toastExpiredMsg{id} })
}

func (m *Model) expireToast(id int) {
	m.toasts = slices.DeleteFunc(m.toasts, func(t toast) bool { return t.id == id })
}

func (m *Model) toastView(t toast) string {
	accent := m.th.Primary
	if t.kind == toastWarn {
		accent = m.th.Warning
	}
	text := ansi.Truncate(t.text, max(min(m.width-8, 60), 8), "…")
	return lipgloss.NewStyle().
		Border(lipgloss.Border{Left: "▌"}, false, false, false, true).BorderForeground(accent).
		Background(m.th.Surface).Foreground(m.th.Text).Padding(0, 1).
		Render(text)
}

func (m *Model) openOverlay(o overlay) { m.overlay = o }
