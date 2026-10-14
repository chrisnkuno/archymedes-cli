package tui

import (
	"fmt"
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

// The home screen's photo, in cells: close to square once the 1:2 cell is counted.
const homePhotoCols, homePhotoRows = 28, 11

// landingVisible is whether the landing screen is what the transcript area shows.
func (m *Model) landingVisible() bool {
	return len(m.tr.items) == 0 && m.phase != failed
}

func (m *Model) landing(width, height int) []string {
	th := m.th
	solid := render.Geometry(m.angle, false)
	// Each row of the mark is a step along the theme's primary→secondary ramp, and the ramp turns
	// with the solid, so the colour moves with the geometry rather than sitting on it.
	ramp := lipgloss.Blend1D(len(solid)*2, th.Primary, th.Secondary, th.Primary)
	shift := int(m.angle*4) % len(solid)
	for i, row := range solid {
		solid[i] = lipgloss.NewStyle().Foreground(ramp[(i+shift)%len(ramp)]).Render(row)
	}

	info := m.landingInfo()
	markBlock := strings.Join(solid, "\n")
	// The photo beside the mark, when there is room for both and the info: three columns on a wide
	// screen, mark and photo over the info on a tall one, and without the photo otherwise.
	photoCols, photoRows := homePhotoCols, homePhotoRows
	card := m.photoCard(m.homePhoto(), photoCols, photoRows)
	if card != nil && m.homeSixel() {
		// Drawn in Sixel over these cells once the frame is on screen (sixel.go): blank them.
		for i := range photoRows {
			card[i] = strings.Repeat(" ", photoCols)
		}
	}
	// The whole card is one click target: a click opens it in the Gallery.
	photo := mark(m.zones.frame, "photo", strings.Join(card, "\n"))
	infoWidth := 0
	for _, line := range info {
		infoWidth = max(infoWidth, ansi.StringWidth(line))
	}
	var block []string
	switch {
	case card != nil && width >= 23+3+photoCols+4+infoWidth+2 && height >= len(card):
		block = strings.Split(lipgloss.JoinHorizontal(lipgloss.Center, markBlock, "   ", photo, "    ", strings.Join(info, "\n")), "\n")
	case card != nil && width >= 23+3+photoCols+2 && height >= len(card)+1+len(info):
		top := strings.Split(lipgloss.JoinHorizontal(lipgloss.Center, markBlock, "   ", photo), "\n")
		block = append(append(top, ""), centreLines(info, lipgloss.Width(strings.Join(top, "\n")))...)
	case width >= 72 && height >= len(solid):
		block = strings.Split(lipgloss.JoinHorizontal(lipgloss.Center, markBlock, "    ", strings.Join(info, "\n")), "\n")
	case height >= len(solid)+len(info)+1 && width >= 30:
		block = append(append(solid, ""), info...)
	default:
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
	if !m.welcomed {
		// A first run: what to do, in order, rather than a list of keys.
		lines = append(lines, "",
			th.Strong.Render("New here? Three things:"),
			step(th, "1", "Ask about this project — "+keyLabel(m.keys.Complete.Keys())+" picks a start"),
			step(th, "2", keyLabel(m.keys.Mode.Keys())+" sets how much it may do alone"),
			step(th, "3", "Apps are on the dock; "+keyLabel(m.keys.Start.Keys())+" finds anything"),
		)
	} else {
		lines = append(lines, "",
			tip(th, "enter", "ask anything"),
			tip(th, keyLabel(m.keys.Start.Keys()), "find anything"),
			tip(th, keyLabel(m.keys.Mode.Keys()), "plan · build · auto"),
			tip(th, keyLabel(m.keys.Changes.Keys()), "what changed"),
		)
	}
	if m.phase != connecting {
		lines = append(lines, "", th.Faint.Render("try one — "+keyLabel(m.keys.Complete.Keys())+" or click"))
		for i, starter := range m.starters() {
			row := th.Key.Render("› ") + th.Body.Render(ansi.Truncate(starter, 44, "…"))
			if m.input.value() == starter {
				row = th.Title.Render("› " + ansi.Truncate(starter, 44, "…"))
			}
			lines = append(lines, mark(m.zones.frame, fmt.Sprintf("starter:%d", i), row))
		}
	}
	return lines
}

// step is one numbered first-run step.
func step(th theme.Theme, n, text string) string {
	return th.Key.Render(n+"  ") + th.Body.Render(text)
}

// centreLines pads each line so the block sits centred in width.
func centreLines(lines []string, width int) []string {
	blockWidth := 0
	for _, line := range lines {
		blockWidth = max(blockWidth, ansi.StringWidth(line))
	}
	pad := strings.Repeat(" ", max((width-blockWidth)/2, 0))
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i] = pad + line
	}
	return out
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
