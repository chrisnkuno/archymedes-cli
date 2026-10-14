package render

import (
	"math"
	"strings"
	"testing"
)

// Every angle the mark can be at, finely enough that a rounding edge case shows up.
func angles() []float64 {
	var out []float64
	for a := 0.0; a < 2*math.Pi*2; a += 0.037 {
		out = append(out, a)
	}
	return out
}

func TestTheMarkIsAlwaysTheSameSizeAtEveryAngle(t *testing.T) {
	for _, a := range angles() {
		grid := Mark(a, false)
		if len(grid) != MarkHeight {
			t.Fatalf("angle %.2f: %d rows", a, len(grid))
		}
		for y, row := range grid {
			if len(row) != MarkWidth {
				t.Fatalf("angle %.2f row %d: %d cells", a, y, len(row))
			}
		}
	}
}

func TestTheBeamAlwaysEntersAndTheFanAlwaysLeavesAndReachesTheEdge(t *testing.T) {
	for _, a := range angles() {
		grid := Mark(a, false)
		if grid[MarkHeight/2+1][0].Kind != KindBeam {
			t.Fatalf("angle %.2f: no beam entering at the left edge\n%s", a, strings.Join(Plain(grid), "\n"))
		}
		spectrum := false
		for y := range MarkHeight {
			if grid[y][MarkWidth-1].Kind == KindSpectrum || grid[y][MarkWidth-2].Kind == KindSpectrum || grid[y][MarkWidth-3].Kind == KindSpectrum {
				spectrum = true
			}
		}
		if !spectrum {
			t.Fatalf("angle %.2f: the fan does not reach the right edge\n%s", a, strings.Join(Plain(grid), "\n"))
		}
	}
}

func TestTheBeamMeetsTheGlassWithNoGap(t *testing.T) {
	for _, a := range angles() {
		grid := Mark(a, false)
		row := MarkHeight/2 + 1
		x := 0
		for x < MarkWidth && grid[row][x].Kind == KindBeam {
			x++
		}
		if x == 0 || x >= MarkWidth {
			t.Fatalf("angle %.2f: beam is %d cells", a, x)
		}
		if k := grid[row][x].Kind; k != KindEdge && k != KindVertex && k != KindGlint {
			t.Fatalf("angle %.2f: the beam stops at %v (col %d), not at the glass\n%s", a, k, x, strings.Join(Plain(grid), "\n"))
		}
	}
}

func TestThePrismTurnsAndTheFanBreathes(t *testing.T) {
	seen := map[string]bool{}
	for a := 0.0; a < 2*math.Pi; a += 0.3 {
		seen[strings.Join(Plain(Mark(a, false)), "\n")] = true
	}
	if len(seen) < 15 {
		t.Fatalf("only %d distinct frames in a turn", len(seen))
	}
	spreadAt := func(a float64) int {
		top, bottom := MarkHeight, 0
		for y, row := range Mark(a, false) {
			if row[MarkWidth-1].Kind == KindSpectrum || row[MarkWidth-2].Kind == KindSpectrum {
				top, bottom = min(top, y), max(bottom, y)
			}
		}
		return bottom - top
	}
	// sin(2*angle) is 1 at pi/4 and -1 at 3pi/4: the fan is widest and narrowest there.
	if spreadAt(math.Pi/4) <= spreadAt(3*math.Pi/4) {
		t.Fatalf("the fan should open and close as the prism turns: %d vs %d", spreadAt(math.Pi/4), spreadAt(3*math.Pi/4))
	}
}

func TestTheMarkIsDeterministic(t *testing.T) {
	for _, a := range []float64{0, 1.234, 5.5} {
		if strings.Join(Plain(Mark(a, false)), "\n") != strings.Join(Plain(Mark(a, false)), "\n") {
			t.Fatalf("angle %.2f differs between calls", a)
		}
	}
}

func TestTheAsciiMarkUsesOnlyAscii(t *testing.T) {
	for _, a := range angles() {
		for _, row := range Plain(Mark(a, true)) {
			for _, r := range row {
				if r > 126 {
					t.Fatalf("angle %.2f: non-ASCII %q in %q", a, r, row)
				}
			}
		}
	}
}

func TestTheSpectrumRunsRedToVioletTopToBottomWithToneMatchingTheRay(t *testing.T) {
	tones := map[float64]bool{}
	for _, row := range Mark(0.5, false) {
		for _, c := range row {
			if c.Kind == KindSpectrum {
				if c.Tone < 0 || c.Tone > 1 {
					t.Fatalf("tone %v out of range", c.Tone)
				}
				tones[c.Tone] = true
			}
		}
	}
	if len(tones) != 5 {
		t.Fatalf("five rays expected, tones %v", tones)
	}
}
