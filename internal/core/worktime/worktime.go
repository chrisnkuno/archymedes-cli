// Package worktime learns how long work takes in a project, beyond tests (core/testtime): a helper
// of each role, from its start to its report, and a step of the agent's plan. Times are log-normal,
// as test times are: the median and the 90th percentile come from an exponentially weighted mean
// and spread of log-seconds (testtime.Stat). With no runs of its own, a helper borrows the
// project's time per step from other roles ("similar"), else it is a guess from its step limit.
// The interface turns an estimate and the time a helper has run into the time it has left.
package worktime

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/testtime"
)

// Estimate is how long a helper, or a plan step, is expected to take.
type Estimate struct {
	// P50 and P90 are the median and the 90th percentile, in seconds.
	P50 float64 `json:"p50"`
	P90 float64 `json:"p90"`
	// Basis is what it rests on: "history" (this role here before), "similar" (this project's
	// time per step, from other roles), "guess".
	Basis string `json:"basis"`
	Runs  int    `json:"runs"`
	// StepP50 is the median time of one step (a model call and its tools), in seconds; for a plan
	// step it equals P50.
	StepP50 float64 `json:"stepP50"`
}

// The priors. A step is a model call and the tools it asks for: about eight seconds. A helper ends,
// typically, after six tenths of the steps it may take. A plan step is about a minute and a half.
// The spreads are log-seconds, as testtime's: 1.0 is "within a factor of e or so", 0.5 about ±60 %.
const (
	guessStepSeconds  = 8.0
	typicalStepShare  = 0.6
	minTypicalSteps   = 3
	guessPlanSeconds  = 90.0
	sigmaGuess        = 1.0
	sigmaSimilar      = 0.8
	sigmaHistory      = 0.5
	z90               = 1.2816 // the standard normal's 90th percentile
	minRecordedSecond = 1.0
	maxRoles          = 64
	bookVersion       = 1
)

// planKey is the plan step's entry among the roles; a role cannot be named so (roles are words).
const planKey = "#plan-step"

type book struct {
	Version int                       `json:"version"`
	Roles   map[string]*testtime.Stat `json:"roles"` // a whole helper run, by role; and planKey
	Steps   map[string]*testtime.Stat `json:"steps"` // a helper's time per step, by role
}

// Book is one project's work times, kept at .archymedes/work-times.json.
type Book struct {
	path string
	mu   sync.Mutex
	b    *book
}

var books sync.Map // root → *Book

// For is the book of the project at root, shared by every session of this process there.
func For(root string) *Book {
	if b, ok := books.Load(root); ok {
		return b.(*Book)
	}
	b, _ := books.LoadOrStore(root, &Book{path: Path(root)})
	return b.(*Book)
}

// Path is where a project's work times are kept.
func Path(root string) string { return filepath.Join(root, ".archymedes", "work-times.json") }

func (k *Book) load() *book {
	if k.b != nil {
		return k.b
	}
	k.b = &book{Version: bookVersion, Roles: map[string]*testtime.Stat{}, Steps: map[string]*testtime.Stat{}}
	data, err := os.ReadFile(k.path)
	if err != nil {
		return k.b
	}
	var read book
	if json.Unmarshal(data, &read) != nil || read.Version != bookVersion {
		return k.b // a damaged or older file is started over, never trusted half-way
	}
	if read.Roles != nil {
		k.b.Roles = read.Roles
	}
	if read.Steps != nil {
		k.b.Steps = read.Steps
	}
	return k.b
}

func (k *Book) save() {
	trimStats(k.b.Roles)
	trimStats(k.b.Steps)
	data, err := json.Marshal(k.b)
	if err != nil || os.MkdirAll(filepath.Dir(k.path), 0o755) != nil {
		return
	}
	tmp := k.path + ".tmp"
	if os.WriteFile(tmp, data, 0o644) == nil {
		_ = os.Rename(tmp, k.path)
	}
}

// trimStats keeps the most recently used entries, so a project with many custom roles stays small.
func trimStats(m map[string]*testtime.Stat) {
	for len(m) > maxRoles {
		oldest := ""
		for k, s := range m {
			if oldest == "" || s.Last < m[oldest].Last {
				oldest = k
			}
		}
		delete(m, oldest)
	}
}

func lognormal(mu, sigma float64) (p50, p90 float64) {
	return math.Exp(mu), math.Exp(mu + z90*sigma)
}

// typicalSteps is how many steps a role allowed maxSteps usually takes.
func typicalSteps(maxSteps int) float64 {
	return math.Max(typicalStepShare*float64(maxSteps), minTypicalSteps)
}

// Helper is how long a helper of role, allowed maxSteps steps (0: unknown), is expected to take.
func (k *Book) Helper(role string, maxSteps int) Estimate {
	k.mu.Lock()
	defer k.mu.Unlock()
	b := k.load()
	if s := b.Roles[role]; s != nil && s.N > 0 {
		p50, p90 := lognormal(s.Mu, s.Sigma(sigmaHistory))
		step := p50 / typicalSteps(maxSteps)
		if st := b.Steps[role]; st != nil && st.N > 0 {
			step = st.Seconds()
		}
		return Estimate{P50: p50, P90: p90, Basis: "history", Runs: s.N, StepP50: step}
	}
	steps := typicalSteps(maxSteps)
	if mu, n, ok := pooledStep(b.Steps); ok {
		p50, p90 := lognormal(mu+math.Log(steps), sigmaSimilar)
		return Estimate{P50: p50, P90: p90, Basis: "similar", Runs: n, StepP50: math.Exp(mu)}
	}
	p50, p90 := lognormal(math.Log(guessStepSeconds*steps), sigmaGuess)
	return Estimate{P50: p50, P90: p90, Basis: "guess", StepP50: guessStepSeconds}
}

// pooledStep is the project's time per step over every role, weighted by runs, in log-seconds.
func pooledStep(steps map[string]*testtime.Stat) (mu float64, runs int, ok bool) {
	for _, s := range steps {
		if s.N > 0 {
			mu += float64(s.N) * s.Mu
			runs += s.N
		}
	}
	if runs == 0 {
		return 0, 0, false
	}
	return mu / float64(runs), runs, true
}

// RecordHelper learns one finished helper run of role: how long it took, in how many steps.
// A run under a second is not one (it failed to start, or was answered from nothing).
func (k *Book) RecordHelper(role string, took time.Duration, steps int) {
	seconds := took.Seconds()
	if seconds < minRecordedSecond || role == "" || role == planKey {
		return
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	b := k.load()
	now := time.Now()
	stat(b.Roles, role).Add(seconds, now)
	if steps > 0 {
		stat(b.Steps, role).Add(seconds/float64(steps), now)
	}
	k.save()
}

// PlanStep is how long one step of the agent's plan is expected to take.
func (k *Book) PlanStep() Estimate {
	k.mu.Lock()
	defer k.mu.Unlock()
	if s := k.load().Roles[planKey]; s != nil && s.N > 0 {
		p50, p90 := lognormal(s.Mu, s.Sigma(sigmaHistory))
		return Estimate{P50: p50, P90: p90, Basis: "history", Runs: s.N, StepP50: p50}
	}
	p50, p90 := lognormal(math.Log(guessPlanSeconds), sigmaGuess)
	return Estimate{P50: p50, P90: p90, Basis: "guess", StepP50: p50}
}

// RecordPlanStep learns one plan step, from in progress to done.
func (k *Book) RecordPlanStep(took time.Duration) {
	if took.Seconds() < minRecordedSecond {
		return
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	stat(k.load().Roles, planKey).Add(took.Seconds(), time.Now())
	k.save()
}

func stat(m map[string]*testtime.Stat, key string) *testtime.Stat {
	s := m[key]
	if s == nil {
		s = &testtime.Stat{}
		m[key] = s
	}
	return s
}
