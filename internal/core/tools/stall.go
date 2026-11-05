package tools

import "time"

// The stall rule: when a running command looks stuck. A command is busy while it prints or while
// its process tree uses the processor; one that has done neither for StallAfter looks stuck. The
// rule is a pure function of samples (a clock reading, when it last printed, its CPU ticks), so a
// test drives it with a clock of its own.
const (
	// StallAfter is how long a running command may print nothing and use no CPU before it is
	// called stuck.
	StallAfter = 5 * time.Minute
	// idleCPU is the CPU share, in percent of one core, under which a process tree counts as idle.
	idleCPU = 1.0
	// clockTicks is the kernel's CPU clock rate (USER_HZ), which /proc counts in; 100 on every
	// Linux Friday runs on.
	clockTicks = 100
)

// stallSample is one look at a command.
type stallSample struct {
	At         time.Time
	LastOutput time.Time // zero while it has printed nothing
	Ticks      uint64    // CPU ticks its process tree has used, when CPUKnown
	CPUKnown   bool
	Running    bool
}

// stallState is what the rule makes of the samples so far.
type stallState struct {
	CPU      float64 // percent of one core since the previous sample
	CPUKnown bool
	// Quiet is how long since it last printed or used the processor.
	Quiet time.Duration
	Stuck bool
}

// stallWatch remembers what the rule needs between samples.
type stallWatch struct {
	started    time.Time
	cpuActive  time.Time // the last sample that found it using the processor
	lastTicks  uint64
	lastSample time.Time
	sampled    bool
}

func newStallWatch(started time.Time) *stallWatch { return &stallWatch{started: started} }

// observe takes one sample. Without a CPU reading nothing is called stuck (a silent compile and a
// hung one look the same from their output), but the quiet is still measured. Before the first
// CPU reading the processor counts as busy, so a command first looked at late is watched for the
// whole threshold before it is called stuck.
func (w *stallWatch) observe(s stallSample) stallState {
	st := stallState{CPUKnown: s.CPUKnown}
	if s.CPUKnown {
		switch {
		case !w.sampled:
			w.cpuActive = s.At
		case s.Ticks < w.lastTicks:
			// A process of the tree ended and took its count with it: something happened.
			w.cpuActive = s.At
		default:
			if dt := s.At.Sub(w.lastSample).Seconds(); dt > 0 {
				st.CPU = float64(s.Ticks-w.lastTicks) / clockTicks / dt * 100
			}
			if st.CPU >= idleCPU {
				w.cpuActive = s.At
			}
		}
		w.lastTicks, w.lastSample, w.sampled = s.Ticks, s.At, true
	}
	active := w.started
	for _, t := range []time.Time{s.LastOutput, w.cpuActive} {
		if t.After(active) {
			active = t
		}
	}
	st.Quiet = max(s.At.Sub(active), 0)
	st.Stuck = s.Running && s.CPUKnown && st.Quiet >= StallAfter
	return st
}
