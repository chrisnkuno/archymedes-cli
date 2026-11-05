package tools

import (
	"math/rand"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)

// idleAt is a sample of a running process that used no CPU since ticks and printed last at out.
func sampleAt(at time.Time, out time.Time, ticks uint64) stallSample {
	return stallSample{At: at, LastOutput: out, Ticks: ticks, CPUKnown: true, Running: true}
}

func TestAQuietIdleCommandLooksStuckOnceTheThresholdPasses(t *testing.T) {
	w := newStallWatch(t0)
	var st stallState
	for at := t0; !at.After(t0.Add(StallAfter + time.Minute)); at = at.Add(2 * time.Second) {
		st = w.observe(sampleAt(at, time.Time{}, 7))
		if at.Sub(t0) < StallAfter && st.Stuck {
			t.Fatalf("stuck at %s, before the threshold %s", at.Sub(t0), StallAfter)
		}
	}
	if !st.Stuck || !st.CPUKnown || st.CPU != 0 {
		t.Fatalf("no output and no CPU for %s should look stuck: %+v", StallAfter+time.Minute, st)
	}
	if st.Quiet < StallAfter {
		t.Fatalf("quiet for %s, want at least %s", st.Quiet, StallAfter)
	}
}

func TestOutputResetsTheStall(t *testing.T) {
	w := newStallWatch(t0)
	w.observe(sampleAt(t0, time.Time{}, 0))
	out := t0.Add(4 * time.Minute)
	if st := w.observe(sampleAt(t0.Add(6*time.Minute), out, 0)); st.Stuck {
		t.Fatalf("printed 2 minutes ago, yet stuck: %+v", st)
	}
	if st := w.observe(sampleAt(out.Add(StallAfter), out, 0)); !st.Stuck {
		t.Fatalf("quiet and idle for %s since its last line should look stuck: %+v", StallAfter, st)
	}
}

func TestCPUResetsTheStall(t *testing.T) {
	w := newStallWatch(t0)
	w.observe(sampleAt(t0, time.Time{}, 0))
	// 4 minutes in, a burst of 30 seconds of CPU since the last sample (a silent compile).
	w.observe(sampleAt(t0.Add(4*time.Minute), time.Time{}, 0))
	busy := w.observe(sampleAt(t0.Add(4*time.Minute+30*time.Second), time.Time{}, 3000))
	if busy.CPU < 50 {
		t.Fatalf("30 s of CPU in 30 s should read near 100%%: %+v", busy)
	}
	if st := w.observe(sampleAt(t0.Add(6*time.Minute), time.Time{}, 3000)); st.Stuck {
		t.Fatalf("busy 90 s ago, yet stuck: %+v", st)
	}
	if st := w.observe(sampleAt(t0.Add(4*time.Minute+30*time.Second).Add(StallAfter), time.Time{}, 3000)); !st.Stuck {
		t.Fatalf("idle for %s after the burst should look stuck: %+v", StallAfter, st)
	}
}

func TestAFinishedCommandNeverLooksStuck(t *testing.T) {
	w := newStallWatch(t0)
	w.observe(sampleAt(t0, time.Time{}, 0))
	s := sampleAt(t0.Add(time.Hour), time.Time{}, 0)
	s.Running = false
	if st := w.observe(s); st.Stuck {
		t.Fatalf("an ended command is not stuck: %+v", st)
	}
}

func TestWithoutACPUReadingNothingLooksStuck(t *testing.T) {
	w := newStallWatch(t0)
	for at := t0; at.Before(t0.Add(time.Hour)); at = at.Add(time.Minute) {
		if st := w.observe(stallSample{At: at, Running: true}); st.Stuck || st.CPUKnown {
			t.Fatalf("CPU unknown: the quiet is reported, never called stuck: %+v", st)
		}
	}
}

// TestStallInvariants drives random histories and holds the rule to its four promises.
func TestStallInvariants(t *testing.T) {
	for seed := int64(1); seed <= 300; seed++ {
		r := rand.New(rand.NewSource(seed))
		w := newStallWatch(t0)
		at, out, lastActive := t0, time.Time{}, t0
		var ticks uint64
		running := true
		for step := 0; step < 200; step++ {
			at = at.Add(time.Duration(1+r.Intn(90)) * time.Second)
			switch r.Intn(10) {
			case 0:
				out, lastActive = at, at // it printed
			case 1:
				ticks += uint64(100 + r.Intn(5000)) // it computed
				lastActive = at
			case 2:
				if r.Intn(20) == 0 {
					running = false
				}
			}
			st := w.observe(stallSample{At: at, LastOutput: out, Ticks: ticks, CPUKnown: true, Running: running})
			if st.Stuck && at.Sub(t0) < StallAfter {
				t.Fatalf("seed %d: stuck %s after start, before the threshold", seed, at.Sub(t0))
			}
			if st.Stuck && at.Sub(lastActive) < StallAfter {
				t.Fatalf("seed %d: stuck %s after it last printed or computed", seed, at.Sub(lastActive))
			}
			if st.Stuck && !running {
				t.Fatalf("seed %d: a finished command looks stuck", seed)
			}
			if st.CPU < 0 {
				t.Fatalf("seed %d: negative CPU %v", seed, st.CPU)
			}
		}
	}
}
