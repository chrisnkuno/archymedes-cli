package render

import (
	"math"
	"strings"
)

// Geometry is the Archymedes mark: nested tetrahedra joined at their vertices, a triangular
// analogue of a hypercube, seen from angle (radians). A port of renderGeometry in
// packages/archymedes-cli/src/render/identity.ts; testdata/geometry.json holds that function's
// output, and the two must agree character for character.
func Geometry(angle float64, ascii bool) []string {
	const width, height = 23, 11
	cells := make([][]rune, height)
	for y := range cells {
		cells[y] = []rune(strings.Repeat(" ", width))
	}
	vertices := [4][3]float64{{0, 1.15, 0}, {-1, -0.7, 0.65}, {1, -0.7, 0.65}, {0, -0.7, -1}}
	project := func(p [3]float64, scale float64) [2]int {
		x, y, z := p[0], p[1], p[2]
		yaw := angle + 0.25
		rx := (x*math.Cos(yaw) + z*math.Sin(yaw)) * scale
		rz := (-x*math.Sin(yaw) + z*math.Cos(yaw)) * scale
		tilt := 0.3 + math.Sin(angle)*0.18
		ry := y*scale*math.Cos(tilt) - rz*math.Sin(tilt)
		depth := y*scale*math.Sin(tilt) + rz*math.Cos(tilt)
		perspective := 3.8 / (3.8 + depth)
		return [2]int{clampInt(jsRound(11+rx*perspective*8), 0, 22), clampInt(jsRound(5-ry*perspective*3.8), 0, 10)}
	}
	var outer, inner [4][2]int
	for i, v := range vertices {
		outer[i], inner[i] = project(v, 1), project(v, 0.43)
	}
	line := func(a, b [2]int, faint bool) {
		dx, dy := b[0]-a[0], b[1]-a[1]
		steps := max(abs(dx), abs(dy))
		glyph := '.'
		if !faint {
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
			x := jsRound(float64(a[0]) + float64(dx*step)/float64(steps))
			y := jsRound(float64(a[1]) + float64(dy*step)/float64(steps))
			if y >= 0 && y < height && x >= 0 && x < width && (!faint || cells[y][x] == ' ') {
				cells[y][x] = glyph
			}
		}
	}
	// Hidden edges first, so the silhouette stays crisp as the solid turns.
	for i := range 4 {
		line(outer[i], inner[i], true)
	}
	for _, points := range [][4][2]int{outer, inner} {
		for i := range 4 {
			for j := i + 1; j < 4; j++ {
				line(points[i], points[j], j == 3)
			}
		}
	}
	vertex := '◇'
	if ascii {
		vertex = '+'
	}
	for _, p := range append(outer[:], inner[:]...) {
		cells[p[1]][p[0]] = vertex
	}
	rows := make([]string, height)
	for y, row := range cells {
		rows[y] = string(row)
	}
	return rows
}

// jsRound is JavaScript's Math.round (halves toward +∞), which the TS original uses; Go's
// math.Round rounds halves away from zero and would move points by a cell on negative halves.
func jsRound(x float64) int { return int(math.Floor(x + 0.5)) }

func clampInt(v, lo, hi int) int { return max(lo, min(v, hi)) }

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
