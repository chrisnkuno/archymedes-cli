package tui

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

const maxDropupRows = 8

// The screen, top to bottom: header (1 row), transcript or landing (the rest), completions, input
// box, status (1 row). Overlays, the approval dialog and toasts are layers composited on top.

func (m *Model) composerHeight() int { return m.input.area.Height() + 2 } // plus the box's borders

func (m *Model) dropupRows() int {
	return min(len(m.input.complete), maxDropupRows, max(m.height/3, 0))
}

func (m *Model) transcriptHeight() int {
	return max(m.height-2-m.composerHeight()-m.dropupRows(), 0)
}

func (m *Model) View() tea.View {
	var v tea.View
	v.AltScreen = true
	v.WindowTitle = m.windowTitle()
	v.ProgramStatus, v.ProgressBar = m.terminalStatus()
	if m.opts.Mouse {
		v.MouseMode = tea.MouseModeCellMotion
	}
	if m.width <= 0 || m.height <= 0 {
		return v
	}

	rows := make([]string, 0, m.height)
	rows = append(rows, m.header())
	for _, line := range m.body(m.transcriptHeight()) {
		rows = append(rows, " "+line)
	}
	for _, line := range m.input.dropup(m.th, m.width, m.dropupRows()) {
		rows = append(rows, " "+line)
	}
	rows = append(rows, strings.Split(m.composerBox(), "\n")...)
	rows = append(rows, m.statusBar())
	if len(rows) > m.height {
		rows = rows[len(rows)-m.height:]
	}
	v.SetContent(m.composite(strings.Join(rows, "\n")))
	return v
}

// body is the transcript area: the landing screen until there is a conversation, then the
// transcript, with a live "thinking" line under it while the agent works on something unseen.
func (m *Model) body(height int) []string {
	width := max(m.width-2, 10)
	if m.landingVisible() {
		return m.landing(width, height)
	}
	ctx := renderCtx{th: m.th, md: m.md, width: width, expanded: m.expanded}
	if !m.thinking() || height < 3 || !m.tr.following() {
		return m.tr.window(ctx, height)
	}
	label := "thinking"
	if m.retrying != "" {
		label = m.retrying
	}
	line := m.spin.View() + " " + theme.Gradient(label+"…", m.th.Primary, m.th.Secondary, false) +
		m.th.Faint.Render(" "+elapsed(time.Since(m.turnStart)))
	return append(m.tr.window(ctx, height-2), "", ansi.Truncate(line, width, "…"))
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
	layers := []*lipgloss.Layer{lipgloss.NewLayer(content)}
	switch {
	case m.approval != nil:
		dialog := m.approval.view(m.th, m.width)
		layers = append(layers, lipgloss.NewLayer(dialog).X(1).Y(max(1+m.transcriptHeight()-lipgloss.Height(dialog), 1)).Z(2))
	case m.overlay != nil:
		box := clipBlock(m.overlay.view(m), m.width, m.height-2)
		x := max((m.width-lipgloss.Width(box))/2, 0)
		y := max(1+(m.transcriptHeight()-lipgloss.Height(box))/2, 1)
		layers = append(layers, lipgloss.NewLayer(box).X(x).Y(y).Z(2))
	}
	y := 1
	for i := len(m.toasts) - 1; i >= 0 && y < m.height-2; i-- {
		t := m.toastView(m.toasts[i])
		layers = append(layers, lipgloss.NewLayer(t).X(max(m.width-lipgloss.Width(t)-1, 0)).Y(y).Z(3))
		y += lipgloss.Height(t)
	}
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

func (m *Model) header() string {
	th := m.th
	left := " " + theme.Gradient("◇ Archymedes", th.Primary, th.Secondary, true)
	if where := m.project(); where != "" {
		left += th.Faint.Render("  " + where)
	}
	// The mode always shows; the model chip goes first when the row is short. Work that runs
	// somewhere other than this machine says so in the mode's pill row, since it changes what an
	// edit touches.
	mode := th.Pill(m.mode, th.ModeColor(m.mode)) + " "
	if where := m.session.Info.Workspace; where != "" && where != "local" {
		mode = th.SoftPill(where, th.Warning) + " " + mode
	}
	if info := m.session.Info; info.Model != "" {
		full := th.SoftPill(info.Model, th.Secondary) + " " + mode
		if ansi.StringWidth(left)+ansi.StringWidth(full)+1 <= m.width {
			return spread(left, full, m.width)
		}
	}
	if ansi.StringWidth(left)+ansi.StringWidth(mode)+1 > m.width {
		left = ansi.Truncate(left, max(m.width-ansi.StringWidth(mode)-1, 0), "…")
	}
	return spread(left, mode, m.width)
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
	return lipgloss.NewStyle().
		Border(m.th.Border).BorderForeground(borderColor).
		Width(m.width).
		Render(strings.Join(lines, "\n"))
}

func (m *Model) statusBar() string {
	th := m.th
	var left string
	switch {
	case m.phase == connecting:
		left = m.spin.View() + th.Faint.Render(" starting the agent")
	case m.phase == failed:
		left = th.Bad.Render("✗ agent stopped")
	case m.quitArmed:
		left = th.Warn.Render("ctrl+c again to quit")
	case m.phase == busy:
		left = m.spin.View() + th.Highlight.Render(" working "+elapsed(time.Since(m.turnStart)))
		if len(m.queue) > 0 {
			left += th.Faint.Render(fmt.Sprintf(" · %d queued", len(m.queue)))
		}
	}
	right := th.Faint.Render(fmt.Sprintf("↑%s ↓%s ", compact(m.usage.input), compact(m.usage.output)))
	if left != "" {
		left += th.Faint.Render("  ")
	}
	left = " " + left
	// The key hints get whatever the state and the usage leave; help drops what does not fit.
	hints := m.help
	hints.SetWidth(max(m.width-ansi.StringWidth(left)-ansi.StringWidth(right)-2, 0))
	return spread(left+hints.ShortHelpView(m.keys.shortFor(m)), right, m.width)
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
