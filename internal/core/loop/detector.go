package loop

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// Detector notices a model calling the same tool with the same arguments while nothing changes.
//
// A signature is the tool, its canonical arguments, and the workspace generation: a counter that
// moves on every successful call that changed the workspace. So `go test ./...` run after each of
// five edits is five different signatures (each run can tell the model something new), while the
// same read or the same failing command five times in a row with no edit between is one signature
// repeated, and that is the doom loop (Crush stops on repeats in a ten-call window; Gemini CLI has
// its own detector). The first trip adds a note to the result asking for a different approach; a
// further trip stops the run as stuck, rather than spending the rest of the budget on it.
type Detector struct {
	Window int // calls looked at
	Warn   int // repeats of one signature that earn a note
	Stop   int // repeats that end the run

	generation int
	recent     []string
	warned     map[string]bool
}

// NewDetector uses a ten-call window, a note at three repeats and a stop at five.
func NewDetector() *Detector {
	return &Detector{Window: 10, Warn: 3, Stop: 5, warned: map[string]bool{}}
}

// Verdict is what the detector says about one call.
type Verdict struct {
	Note string
	Stop bool
}

// Changed records that the workspace changed: what came before may now answer differently.
func (d *Detector) Changed() { d.generation++ }

// Observe records a call and judges it.
func (d *Detector) Observe(name string, args map[string]any) Verdict {
	sig := d.signature(name, args)
	d.recent = append(d.recent, sig)
	if len(d.recent) > d.Window {
		d.recent = d.recent[len(d.recent)-d.Window:]
	}
	count := 0
	for _, s := range d.recent {
		if s == sig {
			count++
		}
	}
	switch {
	case count >= d.Stop:
		return Verdict{Stop: true, Note: fmt.Sprintf("Stopped: %s was called %d times with the same arguments and nothing changed in between.", name, count)}
	case count >= d.Warn && !d.warned[sig]:
		d.warned[sig] = true
		return Verdict{Note: fmt.Sprintf("[You have called %s with these same arguments %d times and nothing has changed since; the result will not change either. Use what you already have, or try a different approach.]", name, count)}
	}
	return Verdict{}
}

func (d *Detector) signature(name string, args map[string]any) string {
	// encoding/json sorts map keys, so this is canonical for decoded JSON arguments.
	data, _ := json.Marshal(args)
	sum := sha256.Sum256(append([]byte(fmt.Sprintf("%s\x00%d\x00", name, d.generation)), data...))
	return hex.EncodeToString(sum[:8])
}
