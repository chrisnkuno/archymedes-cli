package tui

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/progress"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

const maxDropupRows = 8

// The screen, top to bottom: the top bar (1 row), the focused window — Chat's transcript or landing,
// completions and input box, or an app — and the dock (1 row). Dialogs, the approval and toasts are
// layers composited on top.

func (m *Model) composerHeight() int { return m.input.area.Height() + 2 } // plus the box's borders

func (m *Model) dropupRows() int {
	return min(len(m.input.complete), maxDropupRows, max(m.height/3, 0))
}

// windowHeight is the rows between the top bar and the dock.
func (m *Model) windowHeight() int { return max(m.height-2, 0) }

func (m *Model) transcriptHeight() int {
	return max(m.height-2-m.composerHeight()-m.dropupRows(), 0)
}

func (m *Model) View() tea.View {
	var v tea.View
	v.AltScreen = true
	v.WindowTitle = m.windowTitle()
	v.ProgramStatus, v.ProgressBar = m.terminalStatus()
	if m.opts.Mouse && !m.selecting {
		v.MouseMode = tea.MouseModeCellMotion
	}
	if m.width <= 0 || m.height <= 0 || m.quitting {
		return v
	}
	rows := make([]string, 0, m.height)
	rows = append(rows, m.topBar())
	if w := m.activeWindow(); w != nil {
		area := strings.Split(fillHeight(clipBlock(w.view(m), m.width, m.windowHeight()), m.windowHeight()), "\n")
		rows = append(rows, area[:m.windowHeight()]...)
	} else {
		body := m.body(m.transcriptHeight())
		// A selection is kept in screen rows, so text moving under it (a reply streaming in) makes it
		// point at other words: drop it rather than highlight, or copy, the wrong text.
		if (m.sel.pressed || m.sel.shown) && !sameText(steadyLines(body, m.thinking()), steadyLines(m.bodyLines, m.thinking())) {
			m.sel.clear()
		}
		m.bodyLines = body
		for i, line := range body {
			rows = append(rows, " "+m.highlight(i, line))
		}
		for _, line := range m.input.dropup(m.th, m.width, m.dropupRows()) {
			rows = append(rows, " "+line)
		}
		rows = append(rows, strings.Split(m.composerBox(), "\n")...)
	}
	rows = append(rows, m.dock())
	if len(rows) > m.height {
		rows = rows[len(rows)-m.height:]
	}
	v.SetContent(m.underlay(m.composite(strings.Join(rows, "\n")), m.width, m.height))
	return v
}

// body is the transcript area: the landing screen until there is a conversation, then the
// transcript, with a live "thinking" line under it while the agent works on something unseen.
func (m *Model) body(height int) []string {
	width := max(m.width-2, 10)
	if m.landingVisible() {
		return m.landing(width, height)
	}
	ctx := renderCtx{th: m.th, md: m.md, width: width, expanded: m.expanded, root: m.projectRoot(), zones: m.zones.frame}
	if !m.thinking() || height < 3 || !m.tr.following() {
		return m.tr.window(ctx, height)
	}
	line := m.spin.View() + " " + theme.Gradient("thinking…", m.th.Primary, m.th.Secondary, false) +
		m.th.Faint.Render(" "+elapsed(time.Since(m.turnStart)))
	if m.retrying != "" {
		line = m.retryLine()
	}
	return append(m.tr.window(ctx, height-2), "", ansi.Truncate(line, width, "…"))
}

func newRetryBar(th theme.Theme) progress.Model {
	return progress.New(progress.WithColors(th.Warning, th.Primary), progress.WithoutPercentage(), progress.WithWidth(16), progress.WithFillCharacters('━', '─'))
}

// retryLine is a provider retry while it waits: what is being retried, and a bar draining over the
// wait the provider asked for. Redrawn by the busy spinner's frames, so it needs no tick of its own.
func (m *Model) retryLine() string {
	left := m.retryDelay - time.Since(m.retryStart)
	fraction := 0.0
	if m.retryDelay > 0 {
		fraction = min(max(float64(left)/float64(m.retryDelay), 0), 1)
	}
	return m.spin.View() + " " + m.th.Warn.Render(m.retrying) + " " + m.retryBar.ViewAs(fraction) +
		m.th.Faint.Render(fmt.Sprintf(" %.0fs", max(left.Seconds(), 0)))
}

// thinking is a turn in progress with nothing streaming and no tool running: the stretch where,
// without this line, the screen would look frozen.
func (m *Model) thinking() bool {
	if m.phase != busy || (m.current != nil && m.current.text.Len() > 0) {
		return false
	}
	for _, t := range m.tools {
		if !t.done {
			return false
		}
	}
	return true
}

// composite layers what floats over the screen. A Layer's X and Y are only honoured by a
// Compositor, and Canvas.Render trims trailing blank rows, which fillHeight puts back.
func (m *Model) composite(content string) string {
	// The frame's click targets are registered from the frame itself, before anything covers it.
	content = scan(m.zones.frame, content)
	layers := []*lipgloss.Layer{lipgloss.NewLayer(content)}
	switch {
	case m.approval != nil:
		dialog := m.approval.view(m.th, m.width)
		layers = append(layers, lipgloss.NewLayer(dialog).X(1).Y(max(1+m.transcriptHeight()-lipgloss.Height(dialog), 1)).Z(2))
	case m.overlay != nil:
		box := clipBlock(m.overlay.view(m), m.width, m.height-2)
		x := max((m.width-lipgloss.Width(box))/2, 0)
		y := max(1+(m.windowHeight()-lipgloss.Height(box))/2, 1)
		// The dialog's zones (the box, its rows) are registered where it will be drawn.
		box = scanAt(m.zones.dialog, mark(m.zones.dialog, "dialog", box), x, y)
		layers = append(layers, lipgloss.NewLayer(box).X(x).Y(y).Z(2))
	default:
		scan(m.zones.dialog, "") // no dialog: no dialog targets
	}
	// Toasts stack from the top right; their zones are registered as one block at their places.
	var marked []string
	y := 1
	for i := len(m.toasts) - 1; i >= 0 && y < m.height-2; i-- {
		t := m.toastView(m.toasts[i])
		x, h := max(m.width-lipgloss.Width(t)-1, 0), lipgloss.Height(t)
		layers = append(layers, lipgloss.NewLayer(t).X(x).Y(y).Z(3))
		for len(marked) < y {
			marked = append(marked, "")
		}
		for j, line := range strings.Split(mark(m.zones.toasts, fmt.Sprintf("toast:%d", m.toasts[i].id), t), "\n") {
			if y+j >= len(marked) {
				marked = append(marked, "")
			}
			marked[y+j] = strings.Repeat(" ", x) + line
		}
		y += h
	}
	scan(m.zones.toasts, strings.Join(marked, "\n"))
	if len(layers) == 1 {
		return content
	}
	canvas := lipgloss.NewCanvas(m.width, m.height)
	canvas.Compose(lipgloss.NewCompositor(layers...))
	return fillHeight(canvas.Render(), m.height)
}

// clipBlock keeps an overlay inside the screen however small it gets.
func clipBlock(block string, width, height int) string {
	lines := strings.Split(block, "\n")
	if len(lines) > max(height, 1) {
		lines = lines[:max(height, 1)]
	}
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, width, "")
	}
	return strings.Join(lines, "\n")
}

func (m *Model) project() string {
	where := m.session.Info.Root
	if where == "" {
		where = m.opts.Cwd
	}
	if where == "" {
		return ""
	}
	return filepath.Base(where)
}

func (m *Model) composerBox() string {
	borderColor := m.th.BorderFocus
	if m.approval != nil || m.overlay != nil || m.phase == failed {
		borderColor = m.th.BorderColor
	}
	marker := m.th.Title.Render("› ")
	lines := strings.Split(m.input.area.View(), "\n")
	for i := range lines {
		if i == 0 {
			lines[i] = marker + lines[i]
		} else {
			lines[i] = "  " + lines[i]
		}
	}
	return mark(m.zones.frame, "composer", lipgloss.NewStyle().
		Border(m.th.Border).BorderForeground(borderColor).
		Width(m.width).
		Render(strings.Join(lines, "\n")))
}

// windowTitle names the project and, while it matters, what the agent is doing.
func (m *Model) windowTitle() string {
	title := "Archymedes"
	if p := m.project(); p != "" {
		title += " · " + p
	}
	switch {
	case m.approval != nil:
		return "? " + title
	case m.phase == busy:
		return "◇ " + title
	}
	return title
}

// terminalStatus reports state to terminals that show it in a tab or dock (OSC 7501 program
// status, and the native progress bar). Nothing here is only here: the screen says it too.
func (m *Model) terminalStatus() (*tea.ProgramStatus, *tea.ProgressBar) {
	status := &tea.ProgramStatus{App: "archymedes", State: tea.ProgramStateIdle}
	switch {
	case m.phase == failed:
		status.State = tea.ProgramStateError
		return status, &tea.ProgressBar{State: tea.ProgressBarError, Value: 100}
	case m.approval != nil:
		status.State, status.Kind = tea.ProgramStateBlocked, tea.ProgramStatusKindPermission
		return status, &tea.ProgressBar{State: tea.ProgressBarWarning, Value: 50}
	case m.phase == busy, m.phase == connecting:
		status.State = tea.ProgramStateWorking
		return status, &tea.ProgressBar{State: tea.ProgressBarIndeterminate}
	}
	return status, nil
}

// spread puts left and right at either end of a row of width; left wins when they do not fit.
func spread(left, right string, width int) string {
	lw, rw := ansi.StringWidth(left), ansi.StringWidth(right)
	if lw+rw+1 > width {
		return ansi.Truncate(left, width, "…")
	}
	return left + strings.Repeat(" ", width-lw-rw) + right
}

func elapsed(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
}

// fillHeight pads a frame that lost its trailing blank rows (Canvas.Render trims them) back to height.
func fillHeight(content string, height int) string {
	if missing := height - strings.Count(content, "\n") - 1; missing > 0 {
		content += strings.Repeat("\n", missing)
	}
	return content
}

// steadyLines is the transcript without the animated "thinking" line and the gap above it, which
// change every frame without moving any text.
func steadyLines(lines []string, thinking bool) []string {
	if thinking && len(lines) >= 2 {
		return lines[:len(lines)-2]
	}
	return lines
}

func sameText(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
