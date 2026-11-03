package tui

import (
	"math"
	"testing"
)

// The torus drawn from tables is the torus drawn as before, cell for cell and to the last bit, at
// every size and moment tried.
func TestTorusFromTablesIsTheSame(t *testing.T) {
	for _, size := range [][2]int{{20, 10}, {44, 18}, {80, 30}, {7, 3}} {
		for _, at := range []float64{0, 0.37, 1.5, 12.25, 100} {
			got, want := drawTorus(size[0], size[1], at), drawTorusReference(size[0], size[1], at)
			for y := range want {
				for x := range want[y] {
					if got[y][x] != want[y][x] {
						t.Fatalf("%v at %v: cell %d,%d is %+v, was %+v", size, at, x, y, got[y][x], want[y][x])
					}
				}
			}
		}
	}
}

func BenchmarkTorus(b *testing.B) {
	for i := range b.N {
		drawTorus(44, 18, float64(i)*0.1)
	}
}

// drawTorusReference is drawTorus as it was before its angles came from tables (3.12.7).
func drawTorusReference(w, h int, t float64) [][]cell {
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
