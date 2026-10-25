package tui

import (
	"fmt"
	"image/color"
	"math"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// The Showcase app (/tour): what the agent can do, each told by a scene drawn in text. Nothing
// here is a stored picture: every frame is computed — a torus lit and depth-sorted, a globe with
// a moving sun, a plasma in the three mode colours, a tunnel, a Julia set — then textured through
// a ramp of glyphs and coloured from the theme, so it follows /theme like everything else.
// ←/→ change scene, space pauses, esc closes. It animates only while it is the window in front.

// cell is one computed sample: brightness 0..1 (negative is empty), and which palette paints it.
type cell struct {
	v   float64
	hue int
}

type scene struct {
	name, caption, detail string
	ramp                  []rune // dim to bright
	// palettes are the colour stops of each hue, dim to bright.
	palettes func(th theme.Theme) [][]color.Color
	draw     func(w, h int, t float64) [][]cell
}

const (
	showcaseInterval = 70 * time.Millisecond
	showcaseDwell    = 9 * time.Second // a scene's time before the next, unless paused
	showcaseLevels   = 10              // colour steps per palette
)

type showcaseTickMsg struct{}

func showcaseTick() tea.Cmd {
	return tea.Tick(showcaseInterval, func(time.Time) tea.Msg { return showcaseTickMsg{} })
}

type showcaseApp struct {
	scene   int
	t       float64 // the scene's own clock, seconds
	shown   time.Duration
	paused  bool
	ticking bool
}

func (s *showcaseApp) title() string { return "Showcase" }
func (s *showcaseApp) key() string   { return "showcase" }

func (m *Model) openShowcase() tea.Cmd {
	for _, w := range m.windows {
		if s, ok := w.(*showcaseApp); ok {
			m.openWindow(s)
			return s.wake()
		}
	}
	s := &showcaseApp{}
	m.openWindow(s)
	return s.wake()
}

// wake starts the frame clock unless it already runs; it stops itself once the app is not in front.
func (s *showcaseApp) wake() tea.Cmd {
	if s.ticking {
		return nil
	}
	s.ticking = true
	return showcaseTick()
}

// tick advances the scene while the app is in front, and lets the clock lapse otherwise.
func (m *Model) showcaseTicked() tea.Cmd {
	s, ok := m.activeWindow().(*showcaseApp)
	if !ok {
		for _, w := range m.windows {
			if s, ok := w.(*showcaseApp); ok {
				s.ticking = false
			}
		}
		return nil
	}
	if !s.paused {
		s.t += showcaseInterval.Seconds()
		s.shown += showcaseInterval
		if s.shown >= showcaseDwell {
			s.step(1)
		}
	}
	return showcaseTick()
}

func (s *showcaseApp) step(by int) {
	n := len(showcaseScenes)
	s.scene = ((s.scene+by)%n + n) % n
	s.t, s.shown = 0, 0
}

func (s *showcaseApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		return true, nil
	case "right", "l", "n", "tab":
		s.step(1)
	case "left", "h", "p", "shift+tab":
		s.step(-1)
	case "space":
		s.paused = !s.paused
	}
	return false, s.wake()
}

// wheel steps through the scenes, a notch a scene.
func (s *showcaseApp) wheel(_ *Model, up bool) tea.Cmd {
	s.step(map[bool]int{true: -1, false: 1}[up])
	return s.wake()
}

// click on the scene pauses or plays it.
func (s *showcaseApp) click(m *Model, msg tea.MouseClickMsg) tea.Cmd {
	if m.zones.frame.Get("scene").InBounds(msg) {
		s.paused = !s.paused
		return s.wake()
	}
	return nil
}

func (s *showcaseApp) view(m *Model) string {
	th := m.th
	width, height := m.width, max(m.windowHeight(), 1)
	sc := showcaseScenes[s.scene]
	state := ""
	if s.paused {
		state = th.Faint.Render(" · paused")
	}
	header := " " + th.Title.Render(sc.name) + th.Faint.Render(fmt.Sprintf(" · %d/%d", s.scene+1, len(showcaseScenes))) + state
	caption := []string{
		" " + th.Strong.Render(ansi.Truncate(sc.caption, max(width-2, 1), "…")),
		" " + th.Body.Render(ansi.Truncate(sc.detail, max(width-2, 1), "…")),
	}
	pause := "pause"
	if s.paused {
		pause = "play"
	}
	hint := m.hintBar(width, button{"←", "previous"}, button{"→", "next"}, button{"space", pause}, button{"q", "close"})
	artH := height - 1 - len(caption) - 2
	lines := []string{header}
	if artH >= 4 && width >= 12 {
		lines = append(lines, strings.Split(mark(m.zones.frame, "scene", strings.Join(paint(th, sc, sc.draw(width, artH, s.t)), "\n")), "\n")...)
	}
	lines = append(lines, "")
	lines = append(lines, caption...)
	lines = append(lines, hint)
	return strings.Join(fitLines(lines, width, height), "\n")
}

// paint textures a frame: brightness picks the glyph from the scene's ramp and the colour step from
// its palette; a run of cells sharing a colour is styled once, and a blank joins whatever run it is
// in (a space shows no colour), which keeps a frame's escapes to a few per row.
func paint(th theme.Theme, sc scene, grid [][]cell) []string {
	stops := sc.palettes(th)
	styles := make([][]lipgloss.Style, len(stops))
	for hue, s := range stops {
		for _, c := range lipgloss.Blend1D(showcaseLevels, s...) {
			styles[hue] = append(styles[hue], lipgloss.NewStyle().Foreground(c))
		}
	}
	out := make([]string, len(grid))
	for y, row := range grid {
		var b, run strings.Builder
		runHue, runLevel := -1, -1
		flush := func() {
			if runHue < 0 {
				b.WriteString(run.String())
			} else {
				b.WriteString(styles[runHue][runLevel].Render(run.String()))
			}
			run.Reset()
		}
		for _, c := range row {
			v := math.Min(c.v, 1)
			if c.v < 0 || c.hue >= len(styles) || sc.ramp[int(v*float64(len(sc.ramp)-1)+0.5)] == ' ' {
				run.WriteByte(' ')
				continue
			}
			level := int(v*float64(showcaseLevels-1) + 0.5)
			if c.hue != runHue || level != runLevel {
				flush()
				runHue, runLevel = c.hue, level
			}
			run.WriteRune(sc.ramp[int(v*float64(len(sc.ramp)-1)+0.5)])
		}
		flush()
		out[y] = b.String()
	}
	return out
}

func blankGrid(w, h int) [][]cell {
	grid := make([][]cell, h)
	for y := range grid {
		grid[y] = make([]cell, w)
		for x := range grid[y] {
			grid[y][x] = cell{v: -1}
		}
	}
	return grid
}

// hash01 is a fixed pseudo-random value for a cell: stars that stay where they are between frames.
func hash01(x, y int) float64 {
	h := uint32(x)*374761393 + uint32(y)*668265263
	h = (h ^ (h >> 13)) * 1274126177
	return float64(h^(h>>16)) / float64(math.MaxUint32)
}

var showcaseScenes = []scene{
	{
		name:    "Reads before it writes",
		caption: "It reads the whole shape of your code before it changes any of it.",
		detail:  "read_file, grep_files, find_symbol, repo_map, git history: every surface, lit from every side.",
		ramp:    []rune(" .,-~:;=!*#$@"),
		palettes: func(th theme.Theme) [][]color.Color {
			return [][]color.Color{{th.Tint(th.Primary, 0.35), th.Primary, th.Accent, th.Text}}
		},
		draw: drawTorus,
	},
	{
		name:    "Asks when it is your call",
		caption: "When a choice is yours, the agent asks — pick an option or type your own answer.",
		detail:  "ask_user, Claude's AskUserQuestion and Codex's questions all land in one dialog; esc lets it carry on.",
		ramp:    []rune(" .·:-=+*%#@"),
		palettes: func(th theme.Theme) [][]color.Color {
			return [][]color.Color{
				{th.Tint(th.Secondary, 0.3), th.Secondary, th.Text},
				{th.Tint(th.Muted, 0.5), th.Muted, th.Text},
			}
		},
		draw: drawGlobe,
	},
	{
		name:    "Plan · Build · Auto",
		caption: "Three modes, one keystroke apart: shift+tab, /plan, /build, /auto — or a click on the pill.",
		detail:  "Plan reads and proposes, build asks before it changes things, auto just does. Switch mid-turn: it applies when the turn ends.",
		ramp:    []rune(" .:░▒▓█"),
		palettes: func(th theme.Theme) [][]color.Color {
			return [][]color.Color{
				{th.Tint(th.ModeColor("plan"), 0.25), th.ModeColor("plan")},
				{th.Tint(th.ModeColor("build"), 0.25), th.ModeColor("build")},
				{th.Tint(th.ModeColor("auto"), 0.25), th.ModeColor("auto")},
			}
		},
		draw: drawModes,
	},
	{
		name:    "Runs, serves, ships",
		caption: "Scripts in any language, builds, installs and deploys — and servers that stay up.",
		detail:  "run_command waits up to 30 minutes for a deploy; start_application keeps a server (or a worker) running and hands you its URL.",
		ramp:    []rune(" .-:=+*#%@"),
		palettes: func(th theme.Theme) [][]color.Color {
			return [][]color.Color{{th.Tint(th.Primary, 0.15), th.Primary, th.Warning, th.Text}}
		},
		draw: drawTunnel,
	},
	{
		name:    "Every turn, kept",
		caption: "Each turn is a checkpoint: rewind to any of them, code, conversation or both.",
		detail:  "/rewind, /undo, /fork, /resume — a session is a shape you can go back into, at any depth.",
		ramp:    []rune(" .,:;i1tfLCG08@"),
		palettes: func(th theme.Theme) [][]color.Color {
			return [][]color.Color{{th.Tint(th.Secondary, 0.2), th.Secondary, th.Primary, th.Accent}}
		},
		draw: drawJulia,
	},
}

// drawTorus is a ring turning on two axes, depth-sorted and lit from above and behind the viewer.
func drawTorus(w, h int, t float64) [][]cell {
	grid := blankGrid(w, h)
	depth := make([][]float64, h)
	for y := range depth {
		depth[y] = make([]float64, w)
	}
	const r1, r2, k2 = 1.0, 2.0, 5.0
	// Scaled to the smaller of width and twice the height: cells are about twice as tall as wide.
	k1 := math.Min(float64(w)/2, float64(h)) * 0.95 * k2 / (r1 + r2)
	a, b := t*0.9, t*0.45
	sa, ca, sb, cb := math.Sin(a), math.Cos(a), math.Sin(b), math.Cos(b)
	step := 0.5 / math.Max(k1, 10) // finer sampling for a bigger ring, so it never shows holes
	for theta := 0.0; theta < 2*math.Pi; theta += step * 2 {
		st, ct := math.Sin(theta), math.Cos(theta)
		for phi := 0.0; phi < 2*math.Pi; phi += step {
			sp, cp := math.Sin(phi), math.Cos(phi)
			circleX, circleY := r2+r1*ct, r1*st
			x := circleX*(cb*cp+sa*sb*sp) - circleY*ca*sb
			y := circleX*(sb*cp-sa*cb*sp) + circleY*ca*cb
			z := k2 + ca*circleX*sp + circleY*sa
			ooz := 1 / z
			px := int(float64(w)/2 + k1*ooz*x)
			py := int(float64(h)/2 - k1*ooz*y/2)
			if px < 0 || px >= w || py < 0 || py >= h || ooz <= depth[py][px] {
				continue
			}
			lum := cp*ct*sb - ca*ct*sp - sa*st + cb*(ca*st-ct*sa*sp)
			depth[py][px] = ooz
			grid[py][px] = cell{v: math.Max(lum/math.Sqrt2, 0.04)}
		}
	}
	return grid
}

// drawGlobe is a turning planet: procedural continents, a graticule, a moving sun with a specular
// glint, an atmosphere on the rim, and fixed stars that twinkle behind it.
func drawGlobe(w, h int, t float64) [][]cell {
	grid := blankGrid(w, h)
	cx, cy := float64(w)/2, float64(h)/2
	r := math.Min(float64(w)/2, float64(h)) * 0.9
	lx, ly, lz := math.Cos(t*0.35)*0.8, -0.45, 0.55+math.Sin(t*0.35)*0.45
	ln := math.Sqrt(lx*lx + ly*ly + lz*lz)
	lx, ly, lz = lx/ln, ly/ln, lz/ln
	for y := range h {
		for x := range w {
			px, py := (float64(x)+0.5-cx)/r, (float64(y)+0.5-cy)*2/r
			d := px*px + py*py
			if d > 1 {
				if halo := 1 - (math.Sqrt(d)-1)*14; halo > 0 { // a thin atmosphere just past the rim
					grid[y][x] = cell{v: 0.1 * halo, hue: 0}
					continue
				}
				// Few, faint stars, each twinkling at its own pace.
				if s := hash01(x, y); s < 0.004 {
					grid[y][x] = cell{v: 0.1 + 0.25*math.Abs(math.Sin(t*1.7+s*2400)), hue: 1}
				}
				continue
			}
			pz := math.Sqrt(1 - d)
			lon := math.Atan2(px, pz) + t*0.45
			lat := math.Asin(-py)
			land := math.Sin(3*lon)*math.Cos(2*lat) + 0.5*math.Sin(5*lon+1.3)*math.Sin(4*lat+0.7) + 0.25*math.Sin(11*lon+7*lat)
			tex := 0.55
			if land > 0.18 {
				tex = 1
			}
			if g := math.Pi / 6; math.Abs(math.Remainder(lon, g)) < 0.035 || math.Abs(math.Remainder(lat, g)) < 0.05 {
				tex *= 0.55
			}
			diffuse := math.Max(px*lx+(-py)*ly+pz*lz, 0)
			// Reflection of the light about the normal, against a viewer on +z.
			ndl := px*lx + (-py)*ly + pz*lz
			rz := 2*ndl*pz - lz
			spec := math.Pow(math.Max(rz, 0), 24)
			rim := math.Pow(1-pz, 3) * 0.35
			grid[y][x] = cell{v: 0.06 + 0.8*diffuse*tex + 0.7*spec + rim, hue: 0}
		}
	}
	return grid
}

// drawModes is a plasma whose field is cut into three bands, one per mode, each shaded within itself.
func drawModes(w, h int, t float64) [][]cell {
	grid := blankGrid(w, h)
	cx, cy := float64(w)/2, float64(h)/2
	for y := range h {
		for x := range w {
			fx, fy := float64(x), float64(y)*2
			dx, dy := fx-cx, fy-cy*2
			v := math.Sin(fx/9+t) + math.Sin(fy/7+t*0.8) + math.Sin((fx+fy)/13+t*0.55) + math.Sin(math.Sqrt(dx*dx+dy*dy)/6-t*1.4)
			k := (v/4 + 1) / 2 // 0..1
			band := min(int(k*3), 2)
			within := k*3 - float64(band) // 0..1 inside the band
			// Brightest at a band's middle, dark at its edges: the bands read as ridges.
			grid[y][x] = cell{v: 0.15 + 0.85*math.Sin(within*math.Pi), hue: band}
		}
	}
	return grid
}

// drawTunnel flies down a tube: rings at evenly spaced depths rush outward (depth is the inverse of
// the radius, so they spread as they near), ribs run along the walls, the light falls off into the
// distance, and the vanishing point drifts so the flight banks.
func drawTunnel(w, h int, t float64) [][]cell {
	grid := blankGrid(w, h)
	cx, cy := float64(w)/2+math.Sin(t*0.6)*float64(w)/14, float64(h)/2+math.Cos(t*0.45)*float64(h)/12
	reach := math.Min(float64(w)/2, float64(h))
	for y := range h {
		for x := range w {
			dx, dy := float64(x)-cx, (float64(y)-cy)*2
			r := math.Max(math.Hypot(dx, dy), 0.5)
			depth := reach * 0.9 / r
			ring := math.Pow(0.5+0.5*math.Cos(2*math.Pi*(depth-t*1.4)), 4)
			rib := math.Pow(0.5+0.5*math.Cos(math.Atan2(dy, dx)*8+t*0.3), 6)
			// Steep falloff: the far end goes dark before its rings are too close for cells to show.
			light := math.Pow(math.Min(1.4/depth, 1), 1.5)
			grid[y][x] = cell{v: light * (0.1 + 0.75*ring + 0.3*rib*(1-ring))}
		}
	}
	return grid
}

// drawJulia is a Julia set whose constant circles Douady's rabbit, where the set stays whole and
// thick enough to read even in a small panel, breathing in and out so it keeps folding into itself.
func drawJulia(w, h int, t float64) [][]cell {
	grid := blankGrid(w, h)
	cr, ci := -0.123+0.025*math.Cos(t*0.45), 0.745+0.025*math.Sin(t*0.45)
	zoom := 1 + 0.12*math.Sin(t*0.3)
	span := 3.4 // the whole set, about ±1.7
	if math.Min(float64(w)/2, float64(h)) < 16 {
		span = 2.3 // a small panel: closer in, where the shape is thick enough to read in cells
	}
	scale := span / zoom / math.Min(float64(w)/2, float64(h)) / 2
	const limit = 64
	for y := range h {
		for x := range w {
			zr := (float64(x) - float64(w)/2) * scale
			zi := (float64(y) - float64(h)/2) * scale * 2
			i := 0
			for ; i < limit && zr*zr+zi*zi < 16; i++ {
				zr, zi = zr*zr-zi*zi+cr, 2*zr*zi+ci
			}
			if i == limit {
				// Inside: a body textured by where each point's orbit settled.
				grid[y][x] = cell{v: 0.38 + 0.22*math.Sin(math.Hypot(zr, zi)*18+t*1.5)}
				continue
			}
			smooth := float64(i) + 1 - math.Log(math.Log(math.Sqrt(zr*zr+zi*zi)))/math.Ln2
			grid[y][x] = cell{v: math.Pow(math.Max(smooth, 0)/limit, 1.3)}
		}
	}
	return grid
}
