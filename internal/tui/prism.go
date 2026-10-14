package tui

import (
	"fmt"
	"image/color"
	"math"
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/prism"
)

// The home screen's mark, as a lit 3D object (internal/prism) rather than characters: ray traced
// each frame, then drawn as best-fit block glyphs — or as Sixel, at the terminal's own pixels,
// where it draws Sixel. It turns on its own at a steady rate with a slow wobble and a breathing
// core; a drag spins it, and friction brings it back to its own pace, so it moves like a thing with
// weight. Frames are rendered off the event loop, one at a time; a frame that arrives for a pose
// already gone is dropped.
//
// ARCHYMEDES_PRISM: "classic" draws the old character mark; "glyphs" never uses Sixel for it.

const (
	prismSpin     = 0.65 // radians a second it settles to
	prismFriction = 1.4  // seconds for a flick to lose most of its extra speed
	prismDragGain = 0.085
)

type prismState struct {
	yaw, vel float64 // radians, radians a second
	t        float64 // seconds of motion, for the wobble and the breath
	last     time.Time

	dragging bool
	dragX    int
	dragAt   time.Time

	rendering bool
	frame     []string // the glyph frame on screen
	frameKey  string
	sixel     string // the frame as Sixel, when the terminal draws it
}

type prismFrameMsg struct {
	key   string
	lines []string
	sixel string
}

func (m *Model) prismMode() string {
	return strings.ToLower(strings.TrimSpace(os.Getenv("ARCHYMEDES_PRISM")))
}

// prismClassic is whether the mark is the old character drawing.
func (m *Model) prismClassic() bool { return m.prismMode() == "classic" }

// prismSixel is whether the mark is drawn in Sixel: the terminal draws it, nobody said not to, and
// it is not over SSH (a dozen pictures a second is too much to send down a remote link).
func (m *Model) prismSixel() bool {
	return m.homeSixel() && !m.prismClassic() && m.prismMode() != "glyphs" && os.Getenv("SSH_CONNECTION") == ""
}

// prismSize is the mark's size in cells: larger where the home screen has the room.
func (m *Model) prismSize() (int, int) {
	if m.width >= 124 && m.height >= 22 {
		return 30, 14
	}
	return 23, 11
}

// pose is how the mark stands now.
func (p *prismState) pose() prism.Pose {
	return prism.Pose{
		Yaw:    p.yaw + 0.25,
		Tilt:   0.32 + 0.12*math.Sin(p.t*0.8),
		Breath: 0.5 + 0.5*math.Sin(p.t*1.3),
		Bold:   1,
	}
}

// step moves the mark on by dt: towards its own spin (none with reduced motion), at the speed a
// flick gave it, slowed by friction.
func (p *prismState) step(dt float64, motion bool) {
	if p.dragging {
		return // the hand turns it
	}
	target := 0.0
	if motion {
		target = prismSpin
		p.t += dt
	}
	p.vel += (target - p.vel) * (1 - math.Exp(-dt/prismFriction))
	p.yaw += p.vel * dt
}

// prismPalette is the theme's colours over the terminal's background (as it said, or the theme's).
func (m *Model) prismPalette() prism.Palette {
	bg := m.termBg
	if bg == nil {
		bg = m.th.Bg
	}
	if bg == nil {
		bg = color.Black
	}
	return prism.Palette{Primary: m.th.Primary, Secondary: m.th.Secondary, Accent: m.th.Accent, Background: bg}
}

func (m *Model) prismKey(cols, rows int) string {
	p := m.prism.pose()
	cw, ch := m.cellPixels()
	return fmt.Sprintf("%.4f|%.4f|%.3f|%dx%d|%v|%dx%d|%s", p.Yaw, p.Tilt, p.Breath, cols, rows, m.prismSixel(), cw, ch, m.th.Name)
}

// renderPrism is the command that draws the current pose, off the event loop.
func (m *Model) renderPrism() tea.Cmd {
	cols, rows := m.prismSize()
	key := m.prismKey(cols, rows)
	if key == m.prism.frameKey || m.prism.rendering {
		return nil
	}
	m.prism.rendering = true
	pose, pal := m.prism.pose(), m.prismPalette()
	sixel := m.prismSixel()
	cw, ch := m.cellPixels()
	return func() tea.Msg { return drawPrism(key, pose, pal, cols, rows, sixel, cw, ch) }
}

func drawPrism(key string, pose prism.Pose, pal prism.Palette, cols, rows int, sixel bool, cw, ch int) prismFrameMsg {
	msg := prismFrameMsg{key: key}
	if sixel {
		w, h := cols*cw, rows*ch
		h -= h % 6       // whole six-pixel bands, so nothing spills below
		pose.Bold = 0.35 // real pixels: closer to the true proportions
		img := prism.Render(pose, pal, w, h, 1, 1)
		msg.sixel = sixelImage(img)
		msg.lines = blankLines(cols, rows)
		return msg
	}
	img := prism.Render(pose, pal, cols*prism.CellPixels, rows*prism.CellPixels, 0.5, 2)
	msg.lines = prism.Glyphs(img)
	return msg
}

func blankLines(cols, rows int) []string {
	lines := make([]string, rows)
	for i := range lines {
		lines[i] = strings.Repeat(" ", cols)
	}
	return lines
}

// prismFrame takes a rendered frame; in Sixel, it is written over the mark's cells straight away
// (the cells are blank and stay so, so no frame of the interface has to come first).
func (m *Model) prismFrame(msg prismFrameMsg) tea.Cmd {
	m.prism.rendering = false
	m.prism.frame, m.prism.frameKey, m.prism.sixel = msg.lines, msg.key, msg.sixel
	if msg.sixel == "" || !strings.HasPrefix(m.sixelPlace, "home|") {
		return m.renderPrism() // the pose may have moved on while this one was drawn
	}
	z := m.zones.frame.Get("prism")
	if z == nil || z.IsZero() {
		return m.renderPrism()
	}
	return tea.Batch(tea.Raw(ansi.SaveCursor+ansi.CursorPosition(z.StartX+1, z.StartY+1)+msg.sixel+ansi.RestoreCursor), m.renderPrism())
}

// prismLines is the mark for the home screen now: the last frame, or one drawn here for the very
// first (so the home screen never opens on an empty space).
func (m *Model) prismLines() []string {
	cols, rows := m.prismSize()
	if m.prism.frame == nil || len(m.prism.frame) != rows || (len(m.prism.frame) > 0 && ansi.StringWidth(m.prism.frame[0]) != cols) {
		if m.prismSixel() {
			return blankLines(cols, rows)
		}
		msg := drawPrism(m.prismKey(cols, rows), m.prism.pose(), m.prismPalette(), cols, rows, false, 0, 0)
		m.prism.frame, m.prism.frameKey = msg.lines, msg.key
	}
	return m.prism.frame
}

// --- the hand ---

// prismGrab starts a drag on the mark.
func (m *Model) prismGrab(x int) {
	m.prism.dragging, m.prism.dragX, m.prism.dragAt = true, x, time.Now()
	m.prism.vel = 0
}

// prismDrag turns the mark with the pointer, and remembers how fast, for the throw.
func (m *Model) prismDrag(x int) tea.Cmd {
	if !m.prism.dragging {
		return nil
	}
	now := time.Now()
	dx := float64(x - m.prism.dragX)
	dt := math.Max(now.Sub(m.prism.dragAt).Seconds(), 0.016)
	m.prism.yaw += dx * prismDragGain
	m.prism.vel = 0.6*m.prism.vel + 0.4*(dx*prismDragGain/dt)
	m.prism.dragX, m.prism.dragAt = x, now
	return m.renderPrism()
}

// prismRelease lets go: it keeps the speed it was thrown at, and friction does the rest.
func (m *Model) prismRelease() {
	if !m.prism.dragging {
		return
	}
	m.prism.dragging = false
	if time.Since(m.prism.dragAt) > 120*time.Millisecond {
		m.prism.vel = 0 // held still before letting go: no throw
	}
	m.prism.vel = math.Max(-12, math.Min(12, m.prism.vel))
}
