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
	right := m.tourRight(width, height)
	cardWidth := width - right
	card := m.homeCard(cardWidth, height)
	if card == nil {
		return m.withTourDrawer(centre(m.homeInfo(cardWidth, height), cardWidth, height), width, height)
	}
	out := m.withTourDrawer(centre(card, cardWidth, height), width, height)
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
func (m *Model) homeCard(width, height int) []string {
	th := m.th
	inner := min(width-8, 76)
	if inner < 30 || height < 9 {
		return nil
	}
	solid := render.Geometry(m.angle, false)
	withMark := inner >= 23+4+40 && height-2 >= len(solid)
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

// homeInfo is what the home screen says, most important first, fitted to width×height: sections
// that do not fit are left out, lowest priority first, so a short window keeps the essentials.
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
		{0, fit(
			theme.Gradient("F R I D A Y", th.Primary, th.Secondary, true)+m.versionLabel(),
			th.Faint.Render("a coding agent that shows its work"),
		)},
		{2, append(fit(th.Strong.Render(greeting(time.Now(), m.firstRun.name))), wrapped(th.Highlight, spark(m.photoIndex), width)...)},
		{1, fit(m.homeFacts(width)...)},
	}
	if !m.welcomed {
		// A first run: what to do, in order, rather than a list of keys.
		sections = append(sections, section{3, fit(
			th.Strong.Render("New here? Three things:"),
			step(th, "1", "Ask about this project — "+keyLabel(m.keys.Complete.Keys())+" picks a start"),
			step(th, "2", keyLabel(m.keys.Mode.Keys())+" sets how much it may do alone"),
			step(th, "3", "Apps are on the dock; "+keyLabel(m.keys.Start.Keys())+" finds anything"),
			// Said once, where a new person reads: what platform/install-cue.ts sends, and how to stop it.
			th.Faint.Render("Counts installs anonymously (version, OS) · off: Settings or DO_NOT_TRACK=1"),
		)})
	} else {
		sections = append(sections, section{3, fit(
			tip(th, "enter", "ask anything"),
			tip(th, m.newlineKey(), "new line"),
			tip(th, keyLabel(m.keys.Start.Keys()), "find anything"),
			tip(th, keyLabel(m.keys.Mode.Keys()), "plan · build · auto"),
			tip(th, keyLabel(m.keys.Changes.Keys()), "what changed"),
		)})
	}
	if m.phase != connecting {
		lines := []string{th.Faint.Render("try one — " + keyLabel(m.keys.Complete.Keys()) + " or click")}
		for i, starter := range m.starters() {
			row := th.Key.Render("› ") + th.Body.Render(ansi.Truncate(starter, width-2, "…"))
			if m.input.value() == starter {
				row = th.Title.Render("› " + ansi.Truncate(starter, width-2, "…"))
			}
			lines = append(lines, mark(m.zones.frame, fmt.Sprintf("starter:%d", i), row))
		}
		sections = append(sections, section{4, lines})
	}
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

// homeFacts is what is in front of you: the model and who serves it, the mode and what it allows,
// where the work happens, and what the agent can do there.
func (m *Model) homeFacts(width int) []string {
	th := m.th
	// Pills carry a cell of padding; a plain value gets the same, so every value starts in one column.
	label := func(name string) string { return th.Faint.Render(padRight(name, 7)) }
	if m.phase == connecting {
		return []string{th.Highlight.Render(m.spin.View() + " starting the agent…")}
	}
	var lines []string
	info := m.session.Info
	if info.Model != "" {
		served := ""
		if info.ProviderLabel != "" {
			served = th.Faint.Render(" on ") + th.Body.Render(info.ProviderLabel)
		}
		lines = append(lines, label("model")+th.SoftPill(info.Model, th.Secondary)+served)
	}
	lines = append(lines, label("mode")+th.Pill(m.mode, th.ModeColor(m.mode))+" "+th.Faint.Render(modeBlurb[m.mode]))
	where := info.Root
	if where == "" {
		where = m.opts.Cwd
	}
	if where != "" {
		place := th.Body.Render(" " + filepath.Base(where))
		if info.WorkspaceLabel != "" && info.Workspace != "local" {
			place += th.Faint.Render(" · " + info.WorkspaceLabel)
		}
		lines = append(lines, label("in")+place)
	}
	lines = append(lines, label("can")+th.Body.Render(" "+ansi.Truncate(abilities(m.mode), max(width-8, 8), "…")))
	return lines
}

// wrapped is text in style, wrapped to width.
func wrapped(style lipgloss.Style, text string, width int) []string {
	return strings.Split(style.Width(width).Render(text), "\n")
}

// abilities is what the agent can do in a mode, in a phrase.
func abilities(mode string) string {
	switch mode {
	case "plan":
		return "read, search, plan; changes nothing"
	case "auto":
		return "read, edit, run and verify, unasked"
	case "defender":
		return "triage, scan for secrets, playbooks"
	}
	return "read, edit, run; you approve changes"
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

// sparks are the lines that turn with the photo: something to start on.
var sparks = []string{
	"What will you build today?",
	"Pick a corner of the code you have never read. Start there.",
	"Ship something small before lunch.",
	"Break it, read the error, fix it. That is the job.",
	"Curiosity compiles.",
	"Explore. Make. Repeat.",
	"A good question is half a program.",
	"Today's experiment is tomorrow's feature.",
	"Leave the code a little better than you found it.",
	"Write the test first. Thank yourself later.",
	"Big systems are small ideas that kept going.",
	"Try the thing. See what happens.",
	"Make something you would want to use.",
	"Every bug is a question the code is asking.",
	"Start rough. Refine later.",
	"The best way to learn a codebase is to change it.",
}

// spark is the line for the photo at index i.
func spark(i int) string {
	return sparks[((i%len(sparks))+len(sparks))%len(sparks)]
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
	return th.Key.Render(padRight(key, max(11, ansi.StringWidth(key)+1))) + th.Faint.Render(desc)
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
