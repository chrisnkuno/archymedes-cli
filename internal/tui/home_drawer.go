package tui

import (
	"fmt"
	"math"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/config"
)

// The tour drawer: the /tour scenes, full size and full colour, in a panel on the right of the home
// screen. It slides in from the edge (and the card slides over to make room), the scenes pass
// through it as a carousel, one sliding out as the next slides in, and it folds away to a slim tab
// at the edge — alt+o, a click on its ▸ or on the tab — remembered for the next start. It is only
// offered where the card keeps its full width beside it.

const (
	tourDwell     = 14.0 // seconds each scene stays in the drawer
	tourSlideSecs = 0.8  // seconds one scene takes to slide over the last
	tourPhotoRoom = 2    // the wallpaper keeps at least this much width showing between card and drawer
	tourMinWidth  = 34   // narrower than this a scene no longer reads
	tourMaxWidth  = 72
	tourTabWidth  = 3
)

// tourDrawerWidth is the drawer's full width on a width×height home screen, as the home screen's
// layout gives it (home_desktop.go); 0 when it does not fit.
func (m *Model) tourDrawerWidth(width, height int) int { return m.layoutHome(width, height).drawer }

// tourShown is how far the drawer is out, 0 (folded) to 1 (open). Under reduced motion it is
// wherever it is going, with no slide.
func (m *Model) tourShown() float64 {
	if !m.opts.Motion {
		if m.tourOpen {
			return 1
		}
		return 0
	}
	return m.tourSlide
}

// stepTourDrawer eases the drawer toward open or folded; called on the landing's tick.
func (m *Model) stepTourDrawer() {
	target := 0.0
	if m.tourOpen {
		target = 1
	}
	m.tourSlide += (target - m.tourSlide) * 0.3
	if math.Abs(target-m.tourSlide) < 0.02 {
		m.tourSlide = target
	}
}

// toggleTourDrawer opens or folds the drawer and remembers which.
func (m *Model) toggleTourDrawer() tea.Cmd {
	m.tourOpen = !m.tourOpen
	if m.opts.ConfigDir != "" {
		hidden := !m.tourOpen
		_ = config.UpdateState(m.opts.ConfigDir, func(s *config.State) { s.TourHidden = hidden })
	}
	if !m.landingVisible() {
		return m.toast(toastInfo, "The tour drawer is on the home screen; /tour opens it full size")
	}
	return m.animate()
}

// tourRight is how many columns on the right the drawer (or its tab) takes on a home screen.
func (m *Model) tourRight(width, height int) int {
	full := m.tourDrawerWidth(width, height)
	if full == 0 {
		return 0
	}
	return max(int(math.Round(float64(full)*m.tourShown())), tourTabWidth)
}

// withTourDrawer lays the drawer, or its tab, down the right of a home screen already drawn in
// out (width×height), leaving the top and bottom rows to the bars' margin and the photo's credit.
func (m *Model) withTourDrawer(out []string, width, height int) []string {
	full := m.tourDrawerWidth(width, height)
	if _, walkthrough := m.overlay.(*onboarding); full == 0 || walkthrough {
		return out // the walkthrough has the screen to itself
	}
	shown := int(math.Round(float64(full) * m.tourShown()))
	var block []string
	if shown < tourTabWidth {
		block = m.tourTab(height - 2)
		shown = tourTabWidth
	} else {
		block = m.tourDrawer(full, height-2, shown == full)
	}
	for i, line := range block {
		// Sliding: the drawer's left part shows at the edge, as if pushed in from beyond it.
		out[1+i] = splice(out[1+i], ansi.Truncate(line, shown, ""), width-shown, shown)
	}
	return out
}

// tourTab is the folded drawer: a slim tab, centred on the edge, that opens it.
func (m *Model) tourTab(height int) []string {
	th := m.th
	style := lipgloss.NewStyle().Foreground(th.Primary).Background(th.Tint(th.Primary, 0.22))
	rows := []string{" ◂ ", "   ", " t ", " o ", " u ", " r ", "   "}
	block := make([]string, height)
	top := max((height-len(rows))/2, 0)
	for i := range block {
		block[i] = strings.Repeat(" ", tourTabWidth)
	}
	for i, r := range rows {
		if top+i < height {
			block[top+i] = style.Render(r)
		}
	}
	return strings.Split(mark(m.zones.frame, "tour-open", strings.Join(block, "\n")), "\n")
}

// tourScene is where the carousel is at the home clock: the scene in front, the one before it, how
// far the slide from one to the other has got (1 when it is done), and each one's own clock.
func (m *Model) tourScene() (now, before int, slid, nowT, beforeT float64) {
	n := len(showcaseScenes)
	turns := m.homeT / tourDwell
	now = int(turns) % n
	before = (now - 1 + n) % n
	into := (turns - math.Floor(turns)) * tourDwell
	slid = 1
	if into < tourSlideSecs && m.homeT >= tourDwell {
		p := into / tourSlideSecs
		slid = p * p * (3 - 2*p) // smoothstep: it eases off the last scene and onto the next
	}
	return now, before, slid, into + 2, tourDwell + into + 2
}

// tourDrawer is the open drawer, width×height: the scene's name and where it is in the tour, the
// scene itself, and what it stands for. Click targets only once it is fully out: a zone cut in half
// by the slide would catch clicks meant for the card.
func (m *Model) tourDrawer(width, height int, settled bool) []string {
	th := m.th
	inner := width - 4         // rounded border and a cell of padding each side
	artH := max(height-2-5, 4) // header, gap, the art, gap, two lines of caption
	now, before, slid, nowT, beforeT := m.tourScene()
	sc := showcaseScenes[now]

	zone := func(id, s string) string {
		if !settled {
			return s
		}
		return mark(m.zones.frame, id, s)
	}
	var dots []string
	for i := range showcaseScenes {
		dot := th.Faint.Render("○")
		if i == now {
			dot = th.Title.Render("●")
		}
		dots = append(dots, zone(fmt.Sprintf("tour-dot:%d", i), dot))
	}
	right := strings.Join(dots, " ") + "  " + zone("tour-close", th.Faint.Render("▸"))
	name := ansi.Truncate(sc.name, max(inner-ansi.StringWidth(right)-2, 1), "…")
	header := th.Title.Render(name) + strings.Repeat(" ", max(inner-ansi.StringWidth(name)-ansi.StringWidth(right), 1)) + right

	art := paint(th, sc, sc.draw(inner, artH, nowT))
	if slid < 1 {
		// The carousel: the last scene slides out to the left as this one comes in from the right.
		gone := paint(th, showcaseScenes[before], showcaseScenes[before].draw(inner, artH, beforeT))
		cut := int(math.Round(slid * float64(inner)))
		for i := range art {
			art[i] = ansi.TruncateLeft(gone[i], cut, "") + ansi.Truncate(art[i], cut, "")
		}
	}
	for i := range art {
		art[i] += strings.Repeat(" ", max(inner-ansi.StringWidth(art[i]), 0))
	}

	caption := strings.Split(ansi.Wrap(sc.caption, inner, ""), "\n")
	if len(caption) > 2 {
		caption = caption[:2]
		caption[1] = ansi.Truncate(caption[1], inner-1, "") + "…"
	}
	lines := append([]string{header, ""}, zone("tour", strings.Join(art, "\n")))
	lines = append(lines, "")
	for _, c := range caption {
		lines = append(lines, th.Body.Render(c))
	}
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(th.Tint(th.Primary, 0.5)).BorderBackground(th.Bg).
		Background(th.Bg).Padding(0, 1).Width(width).Height(height)
	return strings.Split(onGround(box.Render(strings.Join(lines, "\n")), th.Bg), "\n")
}

// tourClick handles a click on the drawer or its tab; false when the click was elsewhere.
func (m *Model) tourClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	frame := m.zones.frame
	switch {
	case frame.Get("tour-open").InBounds(msg), frame.Get("tour-close").InBounds(msg):
		return m.toggleTourDrawer(), true
	case frame.Get("tour").InBounds(msg):
		now, _, _, _, _ := m.tourScene()
		cmd := m.openShowcase()
		if s, ok := m.activeWindow().(*showcaseApp); ok {
			s.scene, s.t, s.shown = now, 0, 0 // the full tour, on the scene that was clicked
		}
		return cmd, true
	}
	for i := range showcaseScenes {
		if frame.Get(fmt.Sprintf("tour-dot:%d", i)).InBounds(msg) {
			// Straight to that scene, without the slide: a click is a jump, not a turn.
			turns := math.Floor(m.homeT / tourDwell)
			base := turns - float64(int(turns)%len(showcaseScenes))
			m.homeT = (base+float64(i))*tourDwell + tourSlideSecs
			return nil, true
		}
	}
	return nil, false
}
