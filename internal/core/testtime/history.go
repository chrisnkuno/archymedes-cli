package testtime

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Stat is a duration learned from runs, in log-seconds: an exponentially weighted mean and
// variance. Early runs weigh equally (1/n); after that each new run weighs at least minWeight, so
// a suite that got slower is believed within a few runs, not dozens.
type Stat struct {
	N    int     `json:"n"`
	Mu   float64 `json:"mu"`
	Var  float64 `json:"var"`
	Last int64   `json:"last"` // unix seconds of the last update, for eviction
}

const minWeight = 0.3

// Add folds in one run of seconds.
func (s *Stat) Add(seconds float64, now time.Time) {
	x := math.Log(max(seconds, 0.001))
	s.Last = now.Unix()
	if s.N == 0 {
		s.N, s.Mu, s.Var = 1, x, 0
		return
	}
	w := max(1/float64(s.N+1), minWeight)
	d := x - s.Mu
	s.Mu += w * d
	s.Var = (1 - w) * (s.Var + w*d*d)
	s.N++
}

// Sigma is the spread, shrunk toward prior for the first few runs: one run says little about how
// much the next will vary.
func (s Stat) Sigma(prior float64) float64 {
	const k = 2.0
	n := float64(s.N)
	return math.Sqrt((n*s.Var + k*prior*prior) / (n + k))
}

// Seconds is the median.
func (s Stat) Seconds() float64 { return math.Exp(s.Mu) }

// history is one project's learned run times, kept at .archymedes/test-times.json.
type history struct {
	Version int `json:"version"`
	// Runs are whole runs by Run.Key.
	Runs map[string]*Stat `json:"runs"`
	// Units are each runner's units, by name: "go" → "github.com/x/y/pkg" → its time.
	Units map[string]map[string]*Stat `json:"units"`
	// Calibration per runner is the ratio of a run's wall time to its units' makespan: build,
	// start-up and scheduling the units' own times leave out.
	Calibration map[string]*Stat `json:"calibration"`
}

// Bounds on what is kept, so the file stays a few tens of kilobytes whatever the project.
const (
	maxRuns         = 96
	maxUnitsPerRule = 2000
	historyVersion  = 1
)

func newHistory() *history {
	return &history{Version: historyVersion, Runs: map[string]*Stat{}, Units: map[string]map[string]*Stat{}, Calibration: map[string]*Stat{}}
}

// HistoryPath is where a project's test times are kept.
func HistoryPath(root string) string {
	return filepath.Join(root, ".archymedes", "test-times.json")
}

func loadHistory(path string) *history {
	h := newHistory()
	data, err := os.ReadFile(path)
	if err != nil {
		return h
	}
	var read history
	if json.Unmarshal(data, &read) != nil || read.Version != historyVersion {
		return h // a damaged or older file is started over, never trusted half-way
	}
	if read.Runs != nil {
		h.Runs = read.Runs
	}
	if read.Units != nil {
		h.Units = read.Units
	}
	if read.Calibration != nil {
		h.Calibration = read.Calibration
	}
	return h
}

// save writes the history whole and renames it into place, so a reader never sees half a file.
func (h *history) save(path string) error {
	h.evict()
	data, err := json.Marshal(h)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// evict drops the least recently used entries beyond the bounds.
func (h *history) evict() {
	trim(h.Runs, maxRuns)
	for _, units := range h.Units {
		trim(units, maxUnitsPerRule)
	}
}

func trim(m map[string]*Stat, keep int) {
	if len(m) <= keep {
		return
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(a, b int) bool { return m[keys[a]].Last > m[keys[b]].Last })
	for _, k := range keys[keep:] {
		delete(m, k)
	}
}

func (h *history) unit(runner, name string) *Stat {
	units := h.Units[runner]
	if units == nil {
		units = map[string]*Stat{}
		h.Units[runner] = units
	}
	s := units[name]
	if s == nil {
		s = &Stat{}
		units[name] = s
	}
	return s
}

func statFor(m map[string]*Stat, key string) *Stat {
	s := m[key]
	if s == nil {
		s = &Stat{}
		m[key] = s
	}
	return s
}
