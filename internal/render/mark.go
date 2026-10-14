package render

import "math"

// Mark is the wide Archymedes mark: a glass prism turning slowly, a white beam going in on the left,
// and a fan of spectrum leaving on the right. Same quiet line-art as Geometry, with the one thing a
// prism is for added.
//
// It returns typed cells rather than strings so the interface can colour them (the edges along the
// theme's ramp, the beam white, the fan across the spectrum) without parsing glyphs back into meaning.
//
// The beam is attached to the drawn shape, not to a formula: it ends at the left-most edge on its row
// and the fan starts at the right-most edge on its own, so it meets the silhouette wherever the
// prism is in its turn. The fan's spread opens and closes as the prism turns, as a real dispersive
// prism's does when its angle to the beam changes.

// MarkWidth and MarkHeight are the mark's size in cells.
const (
	MarkWidth  = 47
	MarkHeight = 13
)

// CellKind says what a cell of the mark is, so the interface can decide how it looks.
type CellKind uint8

const (
	KindEmpty    CellKind = iota
	KindFar                // an edge on the far side of the prism: dotted, quiet
	KindEdge               // an edge on the near side: the line art itself
	KindVertex             // a corner
	KindGlint              // a spark travelling along an edge
	KindBeam               // the white beam going in
	KindInner              // the beam inside the glass
	KindSpectrum           // a ray of the fan; Tone says which colour
)

// Cell is one character of the mark.
type Cell struct {
	Rune rune
	Kind CellKind
	// Tone is 0..1 along the spectrum for KindSpectrum, and 0..1 down the edge for KindEdge.
	Tone float64
	// Bright marks the cells of a ray that are lit in this frame: they travel outward as it turns.
	Bright bool
}

// Mark draws the mark seen from angle (radians). ascii selects plain ASCII glyphs.
func Mark(angle float64, ascii bool) [][]Cell {
	grid := make([][]Cell, MarkHeight)
	for y := range grid {
		grid[y] = make([]Cell, MarkWidth)
	}
	put := func(x, y int, c Cell, over bool) {
		if x < 0 || x >= MarkWidth || y < 0 || y >= MarkHeight {
			return
		}
		if over || grid[y][x].Kind == KindEmpty {
			grid[y][x] = c
		}
	}

	// A triangular prism, apex up, extruded in depth: two triangles joined at their corners.
	const depth = 0.75
	base := [3][2]float64{{0, 1.15}, {-1.05, -0.75}, {1.05, -0.75}}
	var corners [6][3]float64
	for i, p := range base {
		corners[i] = [3]float64{p[0], p[1], depth}
		corners[i+3] = [3]float64{p[0], p[1], -depth}
	}
	const cx, cy = 23.0, 6.0
	type point struct {
		x, y int
		z    float64 // after rotation; negative is toward the viewer
	}
	project := func(p [3]float64) point {
		yaw, tilt := angle+0.4, 0.26+math.Sin(angle*0.7)*0.06
		x := p[0]*math.Cos(yaw) + p[2]*math.Sin(yaw)
		z := -p[0]*math.Sin(yaw) + p[2]*math.Cos(yaw)
		y := p[1]*math.Cos(tilt) - z*math.Sin(tilt)
		z = p[1]*math.Sin(tilt) + z*math.Cos(tilt)
		scale := 4.4 / (4.4 + z)
		return point{jsRound(cx + x*scale*8.6), jsRound(cy - y*scale*4.5), z}
	}
	var pts [6]point
	for i, c := range corners {
		pts[i] = project(c)
	}

	edges := [][2]int{{0, 1}, {1, 2}, {2, 0}, {3, 4}, {4, 5}, {5, 3}, {0, 3}, {1, 4}, {2, 5}}
	line := func(a, b point, far bool, glintAt float64) {
		dx, dy := b.x-a.x, b.y-a.y
		steps := max(abs(dx), abs(dy))
		glyph := '.'
		if !far {
			switch {
			case abs(dx) > abs(dy)*2:
				glyph = '-'
			case dx == 0:
				glyph = '|'
			case dx*dy > 0:
				glyph = '\\'
			default:
				glyph = '/'
			}
		}
		for step := 1; step < steps; step++ {
			t := float64(step) / float64(steps)
			x := jsRound(float64(a.x) + float64(dx)*t)
			y := jsRound(float64(a.y) + float64(dy)*t)
			cell := Cell{Rune: glyph, Kind: KindEdge, Tone: float64(y) / MarkHeight}
			if far {
				if step%2 == 1 {
					continue // hidden edges are dotted on every other cell: they hint at the back without cluttering
				}
				cell.Kind = KindFar
			}
			if glintAt >= 0 && math.Abs(t-glintAt) < 0.5/float64(steps)+0.04 {
				cell = Cell{Rune: '*', Kind: KindGlint}
				if ascii {
					cell.Rune = '*'
				}
			}
			put(x, y, cell, !far)
		}
	}
	// A spark runs along one edge at a time, a different one each time round.
	glintEdge := int(math.Floor(angle*1.5)) % len(edges)
	if glintEdge < 0 {
		glintEdge += len(edges)
	}
	glintAt := math.Mod(angle*1.5, 1)
	// Far edges first so the near ones overdraw them and the silhouette stays crisp.
	for pass := range 2 {
		for i, e := range edges {
			a, b := pts[e[0]], pts[e[1]]
			far := (a.z+b.z)/2 > 0
			if far != (pass == 0) {
				continue
			}
			g := -1.0
			if i == glintEdge && !far {
				g = glintAt
			}
			line(a, b, far, g)
		}
	}
	vertex := '◇'
	if ascii {
		vertex = '+'
	}
	for _, p := range pts {
		kind := KindVertex
		r := vertex
		if p.z > 0.15 {
			r = '·'
			if ascii {
				r = '.'
			}
			kind = KindFar
		}
		put(p.x, p.y, Cell{Rune: r, Kind: kind}, p.z <= 0.15)
	}

	// Where the beam meets the glass and where the fan leaves it: the nearest and furthest edge
	// cells on their rows, taken from what was just drawn.
	inRow, outRow := int(cy)+1, int(cy)
	left, right := -1, -1
	for x := 0; x < MarkWidth; x++ {
		if grid[inRow][x].Kind == KindEdge || grid[inRow][x].Kind == KindVertex || grid[inRow][x].Kind == KindGlint {
			left = x
			break
		}
	}
	for x := MarkWidth - 1; x >= 0; x-- {
		if grid[outRow][x].Kind == KindEdge || grid[outRow][x].Kind == KindVertex || grid[outRow][x].Kind == KindGlint {
			right = x
			break
		}
	}
	if left < 0 {
		left = int(cx) - 5
	}
	if right < 0 {
		right = int(cx) + 5
	}
	if right <= left+2 { // the prism is edge-on and very thin: keep the beam passing through it
		right = left + 3
	}

	beam, dash := '-', '·'
	if ascii {
		beam, dash = '-', '.'
	}
	for x := range left {
		put(x, inRow, Cell{Rune: beam, Kind: KindBeam, Tone: float64(x) / float64(max(left, 1))}, true)
	}
	// Inside the glass the beam bends up by a row, drawn as a faint dotted line between the faces.
	for x := left + 1; x < right; x++ {
		if (x-left)%2 == 0 {
			continue
		}
		y := inRow
		if float64(x-left)/float64(right-left) > 0.5 {
			y = outRow
		}
		put(x, y, Cell{Rune: dash, Kind: KindInner}, false)
	}

	// The fan. One white stem leaves the glass, then it splits into five rays. The split opens and
	// closes with the turn (the prism's angle to the beam is changing) and leans slightly down, as
	// light bends toward the base. The rays are dashed, and the dashes travel outward as it turns.
	const rays, stem = 5, 3
	spread := 0.06 + 0.04*(0.5+0.5*math.Sin(angle*2))
	phase := int(math.Floor(angle * 9))
	rowAt := func(i, x int) float64 {
		d := float64(x - right - stem)
		return float64(outRow) + (float64(i)-float64(rays-1)/2)*spread*d + 0.04*d
	}
	for x := right + 1; x <= right+stem && x < MarkWidth; x++ {
		put(x, outRow, Cell{Rune: beam, Kind: KindBeam, Tone: 1}, false)
	}
	for i := range rays {
		tone := float64(i) / float64(rays-1)
		for x := right + stem + 1; x < MarkWidth; x++ {
			if (x+i+phase)%3 == 0 {
				continue // the gaps in the dashes
			}
			y := jsRound(rowAt(i, x))
			next := jsRound(rowAt(i, x+1))
			glyph := '-'
			switch {
			case next > y:
				glyph = '\\'
			case next < y:
				glyph = '/'
			}
			put(x, y, Cell{Rune: glyph, Kind: KindSpectrum, Tone: tone, Bright: (x+i*2+phase)%7 < 4}, false)
		}
	}
	return grid
}

// Plain is the mark as text, one string per row, for tests and for places with no colour.
func Plain(cells [][]Cell) []string {
	rows := make([]string, len(cells))
	for y, row := range cells {
		out := make([]rune, len(row))
		for x, c := range row {
			out[x] = ' '
			if c.Kind != KindEmpty {
				out[x] = c.Rune
			}
		}
		rows[y] = string(out)
	}
	return rows
}
