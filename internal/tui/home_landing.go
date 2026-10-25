package tui

import (
	"fmt"
	"image/color"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/render"
	"github.com/chrisnkuno/friday-cli/internal/theme"
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

// The home screen: the day's photo as the wallpaper behind the whole screen, and over it one card
// that says what is in front of you (the model, where it runs, what it may do), a line to
// start on, and the requests worth trying. The photo turns every photoInterval; the line turns with
// it. Without photos, or on a screen too small for a wallpaper, the card stands on its own.
func (m *Model) landing(width, height int) []string {
	// The tour drawer (home_drawer.go) takes the right edge; the card centres in what is left, so it
	// slides over as the drawer slides in.
	layout := m.layoutHome(width, height)
	right := m.tourRight(width, height)
	cardWidth := width - right - layout.iconsW
	card := m.homeCard(cardWidth, height, layout.prism)
	if card == nil {
		card = m.homeInfo(cardWidth, height)
	}
	out := centre(card, cardWidth, height)
	if layout.iconCols > 0 {
		icons := m.desktopIcons(layout.iconCols, height)
		for y := range out {
			out[y] = padRight(icons[y], layout.iconsW) + out[y]
		}
	}
	out = m.withTourDrawer(out, width, height)
	if m.opts.NoPhotos || m.wallChoice == wallpaperNone || height < len(card)+1 {
		return out
	}
	// The wallpaper is laid under the whole screen (desk_wallpaper.go); here, what it is and who took
	// it, in the corner. A click opens it in the Gallery.
	p := m.homePhoto()
	credit := lipgloss.NewStyle().Foreground(m.th.Muted).Hyperlink(p.URL()).Render(ansi.Truncate(p.Title+" · "+p.Byline(), width-2, "…"))
	creditWidth := ansi.StringWidth(credit)
	out[height-1] = splice(out[height-1], mark(m.zones.frame, "photo", credit), max(width-creditWidth-1, 0), creditWidth)
	return out
}

// splice puts over (width cells) into row at column x, keeping the row on both sides of it.
// A row that ends before the piece has no tail: cutting one from it anyway would copy the row's
// zero-width escapes (click-zone markers among them) to after the piece, moving those zones there.
func splice(row, over string, x, width int) string {
	out := ansi.Truncate(row, x, "") + strings.Repeat(" ", max(x-ansi.StringWidth(row), 0)) + over
	if ansi.StringWidth(row) > x+width {
		out += ansi.TruncateLeft(row, x+width, "")
	}
	return out
}

// homeCard is the home screen's card: the mark beside what it says where there is room, in a box
// filled with the theme's ground so the wallpaper never shows through between the words. Nil when
// even the smallest card does not fit.
func (m *Model) homeCard(width, height int, prism bool) []string {
	th := m.th
	inner := min(width-8, 76)
	if inner < 30 || height < 9 {
		return nil
	}
	solid := render.Geometry(m.angle, false)
	withMark := prism && inner >= 23+4+30 && height-2 >= len(solid)
	textWidth := inner
	if withMark {
		textWidth = inner - 23 - 4
	}
	info := m.homeInfo(textWidth, height-2) // the box's borders
	if withMark {
		// Each row of the mark is a step along the theme's primary→secondary ramp, and the ramp
		// turns with the solid, so the colour moves with the geometry rather than sitting on it.
		ramp := lipgloss.Blend1D(len(solid)*2, th.Primary, th.Secondary, th.Primary)
		shift := int(m.angle*4) % len(solid)
		for i, row := range solid {
			solid[i] = lipgloss.NewStyle().Foreground(ramp[(i+shift)%len(ramp)]).Render(row)
		}
		info = strings.Split(lipgloss.JoinHorizontal(lipgloss.Center, strings.Join(solid, "\n"), "    ", strings.Join(info, "\n")), "\n")
	}
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(th.Tint(th.Primary, 0.5)).BorderBackground(th.Bg).
		Background(th.Bg).Padding(0, 2)
	return strings.Split(onGround(box.Render(strings.Join(info, "\n")), th.Bg), "\n")
}

// onGround keeps bg behind every cell of block: each styled run ends in a full reset, which would
// otherwise let the terminal's own background (or the wallpaper) through until the next run. Each
// line still ends in a plain reset, so the ground never runs on into whatever is drawn after it.
func onGround(block string, bg color.Color) string {
	probe := lipgloss.NewStyle().Background(bg).Render("·")
	prefix := probe[:strings.Index(probe, "·")]
	lines := strings.Split(strings.ReplaceAll(block, "\x1b[0m", "\x1b[m"), "\n")
	for i, line := range lines {
		line = strings.ReplaceAll(line, "\x1b[m", "\x1b[m"+prefix)
		lines[i] = strings.TrimSuffix(line, prefix) + "\x1b[m"
	}
	return strings.Join(lines, "\n")
}

// homeInfo is what the home screen says, most important first, fitted to width×height: the name,
// what it runs on, a hello, requests to start from and one line of keys. Sections that do not fit
// are left out, lowest priority first. Everything else is a desktop icon, or a window away.
func (m *Model) homeInfo(width, height int) []string {
	th := m.th
	fit := func(lines ...string) []string {
		for i, line := range lines {
			lines[i] = ansi.Truncate(line, width, "…")
		}
		return lines
	}
	type section struct {
		priority int
		lines    []string
	}
	sections := []section{
		{0, fit(theme.Gradient("F R I D A Y", th.Primary, th.Secondary, true) + m.versionLabel())},
		{1, fit(m.homeFacts(width)...)},
		{3, fit(th.Strong.Render(greeting(time.Now(), m.firstRun.name)))},
	}
	if m.phase != connecting {
		var lines []string
		for i, starter := range m.starters() {
			row := th.Key.Render("› ") + th.Body.Render(ansi.Truncate(starter, width-2, "…"))
			if m.input.value() == starter {
				row = th.Title.Render("› " + ansi.Truncate(starter, width-2, "…"))
			}
			lines = append(lines, mark(m.zones.frame, fmt.Sprintf("starter:%d", i), row))
		}
		sections = append(sections, section{2, lines})
	}
	// The keys worth knowing, as many to a line as fit: a narrow card wraps them between parts.
	var lines []string
	line := ""
	for _, part := range []string{
		th.Key.Render("↑") + th.Faint.Render(" desktop"),
		th.Key.Render(keyLabel(m.keys.Complete.Keys())) + th.Faint.Render(" a start"),
		th.Key.Render(keyLabel(m.keys.Start.Keys())) + th.Faint.Render(" find"),
	} {
		switch {
		case line == "":
			line = part
		case ansi.StringWidth(line)+3+ansi.StringWidth(part) <= width:
			line += th.Faint.Render(" · ") + part
		default:
			lines, line = append(lines, line), part
		}
	}
	lines = fit(append(lines, line)...)
	if !m.welcomed {
		// Said once, where a new person reads: what platform/install-cue.ts sends, and how to stop it.
		lines = append(lines, fit(th.Faint.Render("Counts installs anonymously (version, OS) · off: Settings or DO_NOT_TRACK=1"))...)
	}
	sections = append(sections, section{4, lines})
	// Leave out the lowest-priority sections until what is left fits, a blank line between each.
	for limit := 4; limit >= 0; limit-- {
		var out []string
		for _, s := range sections {
			if s.priority > limit {
				continue
			}
			if len(out) > 0 {
				out = append(out, "")
			}
			out = append(out, s.lines...)
		}
		if len(out) <= height || limit == 0 {
			return out
		}
	}
	return nil
}

// homeFacts is what is in front of you, on one line: the model, the mode, and the project.
func (m *Model) homeFacts(width int) []string {
	th := m.th
	if m.phase == connecting {
		return []string{th.Highlight.Render(m.spin.View() + " starting the agent…")}
	}
	info := m.session.Info
	var parts []string
	if info.Model != "" {
		parts = append(parts, th.SoftPill(info.Model, th.Secondary))
	}
	parts = append(parts, th.Pill(m.mode, th.ModeColor(m.mode)))
	where := info.Root
	if where == "" {
		where = m.opts.Cwd
	}
	if where != "" {
		parts = append(parts, th.Body.Render(filepath.Base(where)))
	}
	line := strings.Join(parts, " ")
	if ansi.StringWidth(line) > width && len(parts) > 1 {
		return []string{parts[0], strings.Join(parts[1:], " ")}
	}
	return []string{line}
}

// wrapped is text in style, wrapped to width.
func wrapped(style lipgloss.Style, text string, width int) []string {
	return strings.Split(style.Width(width).Render(text), "\n")
}

// greeting is hello for the time of day, to name when there is one.
func greeting(now time.Time, name string) string {
	to := ""
	if name != "" {
		to = ", " + name
	}
	switch h := now.Hour(); {
	case h < 5:
		return "Up late" + to + ". Make it count."
	case h < 12:
		return "Good morning" + to + "."
	case h < 18:
		return "Good afternoon" + to + "."
	default:
		return "Good evening" + to + "."
	}
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

// centre places block in the middle of a width×height area, clipping what does not fit.
func centre(block []string, width, height int) []string {
	height = max(height, 0)
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
