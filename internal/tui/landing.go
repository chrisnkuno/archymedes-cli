package tui

import (
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/render"
	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

// The landing screen fills the transcript area until the first message: the mark turning slowly,
// the wordmark, where the session runs, and the few keys worth knowing first. It animates only
// while it is on screen, so an idle session with history does not repaint.

type animTickMsg struct{}

const animInterval = 90 * time.Millisecond

func animTick() tea.Cmd {
	return tea.Tick(animInterval, func(time.Time) tea.Msg { return animTickMsg{} })
}

// landingVisible is whether the landing screen is what the transcript area shows.
func (m *Model) landingVisible() bool {
	return len(m.tr.items) == 0 && m.phase != failed
}

func (m *Model) landing(width, height int) []string {
	th := m.th
	mark := render.Geometry(m.angle, false)
	// Each row of the mark is a step along the theme's primary→secondary ramp, and the ramp turns
	// with the solid, so the colour moves with the geometry rather than sitting on it.
	ramp := lipgloss.Blend1D(len(mark)*2, th.Primary, th.Secondary, th.Primary)
	shift := int(m.angle*4) % len(mark)
	for i, row := range mark {
		mark[i] = lipgloss.NewStyle().Foreground(ramp[(i+shift)%len(ramp)]).Render(row)
	}

	info := m.landingInfo()
	var block []string
	if width >= 72 && height >= len(mark) {
		block = strings.Split(lipgloss.JoinHorizontal(lipgloss.Center, strings.Join(mark, "\n"), "    ", strings.Join(info, "\n")), "\n")
	} else if height >= len(mark)+len(info)+1 && width >= 30 {
		block = append(append(mark, ""), info...)
	} else {
		block = info
	}
	return centre(block, width, height)
}

func (m *Model) landingInfo() []string {
	th := m.th
	where := m.session.Info.Root
	if where == "" {
		where = m.opts.Cwd
	}
	lines := []string{
		theme.Gradient("A R C H Y M E D E S", th.Primary, th.Secondary, true),
		th.Faint.Render("a coding agent that shows its work") + m.versionLabel(),
		"",
	}
	switch {
	case m.phase == connecting:
		lines = append(lines, th.Highlight.Render(m.spin.View()+" starting the agent…"))
	case m.session.Info.Model != "":
		lines = append(lines, th.Pill(m.mode, th.ModeColor(m.mode))+" "+th.SoftPill(m.session.Info.Model, th.Secondary))
	}
	if where != "" {
		lines = append(lines, th.Faint.Render("in ")+th.Body.Render(filepath.Base(where)))
	}
	lines = append(lines, "",
		tip(th, "enter", "ask anything"),
		tip(th, keyLabel(m.keys.Start.Keys()), "find anything"),
		tip(th, keyLabel(m.keys.Mode.Keys()), "plan · build · auto"),
		th.Faint.Render("the dock below opens every app"),
	)
	return lines
}

func tip(th theme.Theme, key, desc string) string {
	return th.Key.Render(padRight(key, 11)) + th.Faint.Render(desc)
}

// centre places block in the middle of a width×height area, clipping what does not fit.
func centre(block []string, width, height int) []string {
	blockWidth := 0
	for _, line := range block {
		blockWidth = max(blockWidth, ansi.StringWidth(line))
	}
	left := strings.Repeat(" ", max((width-blockWidth)/2, 0))
	if len(block) > height {
		block = block[:height]
	}
	top := (height - len(block)) / 2
	out := make([]string, 0, height)
	for range top {
		out = append(out, "")
	}
	for _, line := range block {
		out = append(out, ansi.Truncate(left+line, width, ""))
	}
	for len(out) < height {
		out = append(out, "")
	}
	return out
}

func (m *Model) versionLabel() string {
	if m.opts.Version == "" || m.opts.Version == "dev" {
		return ""
	}
	return m.th.Faint.Render(" · v" + m.opts.Version)
}
