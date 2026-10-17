package tui

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/NimbleMarkets/ntcharts/v2/barchart"
	"github.com/NimbleMarkets/ntcharts/v2/canvas"
	"github.com/NimbleMarkets/ntcharts/v2/linechart/timeserieslinechart"
	"github.com/NimbleMarkets/ntcharts/v2/sparkline"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/gallery"
)

// The Stats app (F9): the session as charts (ntcharts v2), about what a person watching an agent
// asks — how many tokens each turn took, whether turns are getting slower, whether the agent is
// writing or mostly reading, and what it spends its tools on. ←/→ or a click on a bar picks a turn.

type statsApp struct {
	selected int             // the turn whose numbers are shown; -1 is the latest
	bars     *barchart.Model // kept from the last draw, to map a click to its bar
}

func newStatsApp() *statsApp { return &statsApp{selected: -1} }

func (s *statsApp) title() string { return "Stats" }
func (s *statsApp) key() string   { return "stats" }

func (s *statsApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	n := len(m.stats.turns)
	switch msg.String() {
	case "esc", "q":
		return true, nil
	case "left", "h":
		if n > 0 {
			s.selected = max(s.turn(n)-1, 0)
		}
	case "right", "l":
		if n > 0 {
			s.selected = min(s.turn(n)+1, n-1)
		}
	}
	return false, nil
}

// turn is the selected turn's index among n.
func (s *statsApp) turn(n int) int {
	if s.selected < 0 || s.selected >= n {
		return n - 1
	}
	return s.selected
}

// click picks the turn whose bar was clicked.
func (s *statsApp) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	if s.bars == nil {
		return nil
	}
	x, y := m.zones.frame.Get(s.bars.ZoneID()).Pos(msg)
	if x < 0 {
		return nil
	}
	// Anywhere in a bar's column counts — above a short bar, or on its label — not only its cells.
	for _, row := range append([]int{y}, rangeDown(s.bars.Canvas.Height())...) {
		if bar := s.bars.BarDataFromPoint(canvas.Point{X: x, Y: row}); bar.Label != "" {
			if i, err := strconv.Atoi(bar.Label); err == nil && i >= 1 && i <= len(m.stats.turns) {
				s.selected = i - 1
			}
			return nil
		}
	}
	return nil
}

func (s *statsApp) view(m *Model) string {
	th, st := m.th, &m.stats
	width, height := m.width, max(m.windowHeight(), 1)
	lines := []string{" " + ansi.Truncate(s.summary(m), max(width-2, 0), "…")}
	if len(st.turns) == 0 {
		lines = append(lines, m.emptyState(gallery.OfTheme("math", 0), []string{
			th.Body.Render("No turns yet."),
			th.Faint.Render("The charts fill in as you work: tokens, time and tools, turn by turn."),
		}, width, height-1)...)
		return strings.Join(fitLines(lines, width, height), "\n")
	}

	// Two columns of panels where there is room, one otherwise; panels that cannot get at least
	// a few rows are left out rather than drawn illegibly.
	body := height - 3
	var panels []string
	if width >= 90 && body >= 14 {
		colW, rowH := (width-1)/2, body/2
		top := lipgloss.JoinHorizontal(lipgloss.Top, s.tokenPanel(m, colW, rowH), " ", durationPanel(m, width-colW-1, rowH))
		bottom := lipgloss.JoinHorizontal(lipgloss.Top, callPanel(m, colW, body-rowH), " ", toolPanel(m, width-colW-1, body-rowH))
		panels = []string{top, bottom}
	} else {
		// Stacked, most telling first; each panel gets at least seven rows or is left out.
		draws := []func(w, h int) string{
			func(w, h int) string { return s.tokenPanel(m, w, h) },
			func(w, h int) string { return toolPanel(m, w, h) },
			func(w, h int) string { return durationPanel(m, w, h) },
			func(w, h int) string { return callPanel(m, w, h) },
		}
		count := min(max(body/7, 1), len(draws))
		for i := range count {
			h := body / count
			if i == count-1 {
				h = body - h*(count-1)
			}
			panels = append(panels, draws[i](width, h))
		}
	}
	for _, p := range panels {
		lines = append(lines, strings.Split(p, "\n")...)
	}
	lines = fitLines(lines, width, height-1)
	return strings.Join(append(lines, " "+ansi.Truncate(s.turnLine(m), max(width-2, 0), "…")), "\n")
}

func (s *statsApp) summary(m *Model) string {
	th, st := m.th, &m.stats
	var in, out int
	var seconds float64
	for _, t := range st.turns {
		in, out, seconds = in+t.in, out+t.out, seconds+t.seconds
	}
	return th.Title.Render("Stats") + th.Faint.Render(fmt.Sprintf("  %s · %s · %s in · %s out · %s working",
		plural(len(st.turns), "turn"), plural(len(st.calls), "model call"), compact(in), compact(out), elapsed(time.Duration(seconds*float64(time.Second)))))
}

// turnLine is the selected turn's numbers, under the charts.
func (s *statsApp) turnLine(m *Model) string {
	th, n := m.th, len(m.stats.turns)
	t := m.stats.turns[s.turn(n)]
	state := fmt.Sprintf("%.1fs", t.seconds)
	if !t.finished {
		state = "running"
	}
	prompt := strings.Join(strings.Fields(t.prompt), " ")
	return th.Key.Render(fmt.Sprintf("turn %d", s.turn(n)+1)) + th.Body.Render(fmt.Sprintf(" · %s · %s · %s · %s in / %s out", state,
		plural(t.calls, "call"), plural(t.tools, "tool"), compact(t.in), compact(t.out))) + th.Faint.Render(" · “"+prompt+"”  ←/→ or click a bar")
}

// panel frames a chart with its title.
func panel(m *Model, title, chart string, w, h int) string {
	// Lip Gloss v2 counts the border inside Width and Height: the chart gets w-2 by h-3.
	box := lipgloss.NewStyle().Border(m.th.Border).BorderForeground(m.th.BorderColor).Width(max(w, 3)).Height(max(h, 3))
	return clipBlock(box.Render(m.th.Strong.Render(title)+"\n"+chart), w, h)
}

func empty(m *Model, title, why string, w, h int) string {
	return panel(m, title, m.th.Faint.Render(why), w, h)
}

// tokenPanel: one stacked bar per turn (input under output), as many recent turns as fit.
func (s *statsApp) tokenPanel(m *Model, w, h int) string {
	th, turns := m.th, m.stats.turns
	cw, ch := max(w-2, 4), max(h-3, 2)
	// Bars as wide as up to four cells while few turns fill the panel, then the latest that fit.
	barW := min(max((cw+1)/max(len(turns), 1)-1, 1), 4)
	first := max(len(turns)-max((cw+1)/(barW+1), 1), 0)
	bars := barchart.New(cw, ch, barchart.WithNoAutoBarWidth(), barchart.WithBarWidth(barW), barchart.WithBarGap(1), // in this order: the width is set only without auto
		barchart.WithStyles(th.Faint, th.Faint), barchart.WithZoneManager(m.zones.frame))
	selected := s.turn(len(turns))
	for i := first; i < len(turns); i++ {
		in, out := th.Tint(th.Secondary, 0.55), th.Primary
		if i == selected {
			in, out = th.Accent, th.Warning
		}
		bars.Push(barchart.BarData{Label: strconv.Itoa(i + 1), Values: []barchart.BarValue{
			{Name: "in", Value: float64(turns[i].in), Style: lipgloss.NewStyle().Foreground(in)},
			{Name: "out", Value: float64(turns[i].out), Style: lipgloss.NewStyle().Foreground(out)},
		}})
	}
	bars.Draw()
	s.bars = &bars
	legend := "  " + lipgloss.NewStyle().Foreground(th.Tint(th.Secondary, 0.55)).Render("■") + th.Faint.Render(" input ") +
		lipgloss.NewStyle().Foreground(th.Primary).Render("■") + th.Faint.Render(" output")
	return panel(m, "Tokens per turn"+legend, bars.View(), w, h)
}

// durationPanel: seconds per finished turn over time, in braille for resolution in a small box.
func durationPanel(m *Model, w, h int) string {
	th := m.th
	var points []timeserieslinechart.TimePoint
	for _, t := range m.stats.turns {
		if t.finished {
			points = append(points, timeserieslinechart.TimePoint{Time: t.start, Value: t.seconds})
		}
	}
	if len(points) < 2 {
		return empty(m, "Seconds per turn", "needs two finished turns", w, h)
	}
	longest := 0.0
	for _, p := range points {
		longest = max(longest, p.Value)
	}
	chart := timeserieslinechart.New(max(w-2, 8), max(h-3, 3),
		timeserieslinechart.WithTimeRange(points[0].Time, points[len(points)-1].Time), timeserieslinechart.WithYRange(0, math.Ceil(longest*1.1)),
		timeserieslinechart.WithAxesStyles(th.Faint, th.Faint), timeserieslinechart.WithStyle(lipgloss.NewStyle().Foreground(th.Secondary)),
		timeserieslinechart.WithXLabelFormatter(func(_ int, v float64) string { return time.UnixMilli(int64(math.Round(v * 1e3))).Format("15:04") }),
		timeserieslinechart.WithTimeSeries(points))
	chart.DrawBraille()
	return panel(m, "Seconds per turn", chart.View(), w, h)
}

// callPanel: output tokens of every model call, newest right — writing, or mostly reading.
func callPanel(m *Model, w, h int) string {
	th := m.th
	if len(m.stats.calls) == 0 {
		return empty(m, "Output per model call", "no model calls yet", w, h)
	}
	cw := max(w-2, 4)
	data := make([]float64, 0, len(m.stats.calls))
	for _, c := range m.stats.calls {
		data = append(data, float64(c.out))
	}
	if len(data) > cw {
		data = data[len(data)-cw:]
	}
	line := sparkline.New(cw, max(h-3, 1), sparkline.WithStyle(lipgloss.NewStyle().Foreground(th.Primary)), sparkline.WithData(data))
	line.Draw()
	return panel(m, fmt.Sprintf("Output per model call  (last %d)", len(data)), line.View(), w, h)
}

// toolPanel: how often each tool ran, most used first.
func toolPanel(m *Model, w, h int) string {
	th := m.th
	names := m.stats.toolRanking()
	if len(names) == 0 {
		return empty(m, "Tools", "no tools run yet", w, h)
	}
	cw, ch := max(w-2, 8), max(h-3, 1)
	if len(names) > ch {
		names = names[:ch]
	}
	// The names and counts are a column of their own, left of the bars, a row per tool.
	labels := make([]string, len(names))
	labelW := 0
	for i, name := range names {
		labels[i] = fmt.Sprintf("%s %d ", strings.ReplaceAll(name, "_", " "), m.stats.tools[name])
		labelW = max(labelW, ansi.StringWidth(labels[i]))
	}
	labelW = min(labelW, cw/2)
	for i, l := range labels {
		labels[i] = th.Body.Render(ansi.Truncate(fmt.Sprintf("%*s", labelW, l), labelW, "…"))
	}
	bars := barchart.New(max(cw-labelW, 2), len(names), barchart.WithHorizontalBars(), barchart.WithNoAutoBarWidth(),
		barchart.WithBarWidth(1), barchart.WithBarGap(0), barchart.WithNoAxis())
	for _, name := range names {
		bars.Push(barchart.BarData{Values: []barchart.BarValue{
			{Name: name, Value: float64(m.stats.tools[name]), Style: lipgloss.NewStyle().Foreground(th.Secondary)},
		}})
	}
	bars.Draw()
	chart := lipgloss.JoinHorizontal(lipgloss.Top, strings.Join(labels, "\n"), bars.View())
	return panel(m, fmt.Sprintf("Tools  %s", th.Faint.Render(plural(len(m.stats.tools), "kind"))), chart, w, h)
}

// rangeDown is n-1 … 0: a column's rows from the bottom, where every bar has its first cell.
func rangeDown(n int) []int {
	rows := make([]int, n)
	for i := range rows {
		rows[i] = n - 1 - i
	}
	return rows
}

// fitLines makes lines exactly height rows of at most width cells.
func fitLines(lines []string, width, height int) []string {
	if len(lines) > height {
		lines = lines[:height]
	}
	for i, l := range lines {
		lines[i] = ansi.Truncate(l, width, "")
	}
	for len(lines) < height {
		lines = append(lines, "")
	}
	return lines
}
