package testtime

import (
	"bufio"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Estimate is how long a run is expected to take.
type Estimate struct {
	// P50 and P90 are the median and the 90th percentile, in seconds.
	P50 float64 `json:"p50"`
	P90 float64 `json:"p90"`
	// Basis is what it rests on, most trusted first: "history" (this run before), "parts" (its
	// units, timed in other runs), "similar" (other runs of the same runner), "guess" (the number of
	// test files in its scope).
	Basis string `json:"basis"`
	// Runs is how many runs it rests on (0 for a guess).
	Runs int `json:"runs"`
}

// Trusted reports an estimate measured on this project rather than guessed.
func (e Estimate) Trusted() bool { return e.Basis == "history" || e.Basis == "parts" }

// z90 is the standard normal's 90th percentile: P90 = exp(mu + z90·sigma) for a log-normal time.
const z90 = 1.2816

// Spread priors in log-seconds, by basis: how far the truth may be from the centre before any run
// says otherwise. 0.35 is about ±40 %; 1.0 is "within a factor of e or so".
const (
	sigmaHistory = 0.35
	sigmaParts   = 0.5
	sigmaSimilar = 0.8
	sigmaGuess   = 1.0
)

func lognormal(mu, sigma float64, basis string, runs int) Estimate {
	return Estimate{P50: math.Exp(mu), P90: math.Exp(mu + z90*sigma), Basis: basis, Runs: runs}
}

// Estimator is one project's test times: what it learned, and what it is learning.
type Estimator struct {
	root string
	path string

	mu      sync.Mutex
	hist    *history
	files   []string // test files under the root, relative, for the prior
	filesAt time.Time
	module  map[string]string // go.mod module path by directory
	passes  map[string]pass   // runs that passed this process, by key, for reuse
	toplvl  string            // the git work tree's top, "" before it is asked, "-" outside git
	workers int
}

var estimators sync.Map // root → *Estimator

// For is the estimator of the project at root, shared by every session of this process there.
func For(root string) *Estimator {
	if e, ok := estimators.Load(root); ok {
		return e.(*Estimator)
	}
	e, _ := estimators.LoadOrStore(root, &Estimator{root: root, path: HistoryPath(root), module: map[string]string{}, passes: map[string]pass{}, workers: runtime.NumCPU()})
	return e.(*Estimator)
}

func (e *Estimator) load() *history {
	if e.hist == nil {
		e.hist = loadHistory(e.path)
	}
	return e.hist
}

// Estimate is how long run is expected to take, from the most trusted basis there is.
func (e *Estimator) Estimate(run Run) Estimate {
	e.mu.Lock()
	defer e.mu.Unlock()
	h := e.load()
	if s := h.Runs[run.Key()]; s != nil && s.N > 0 {
		return lognormal(s.Mu, s.Sigma(sigmaHistory), "history", s.N)
	}
	if est, ok := e.fromParts(h, run); ok {
		return est
	}
	if est, ok := e.fromSimilar(h, run); ok {
		return est
	}
	return e.guess(run)
}

// flagFactor is how much a run's cost-changing flags multiply a time measured without them.
func flagFactor(flags []string) float64 {
	f := 1.0
	for _, flag := range flags {
		name, value, _ := strings.Cut(flag, "=")
		switch name {
		case "race":
			f *= 3
		case "cover", "coverage", "coverprofile", "covermode":
			f *= 1.3
		case "short":
			f *= 0.6
		case "count":
			if n, err := strconv.Atoi(value); err == nil && n > 1 {
				f *= float64(n)
			}
		case "runInBand":
			f *= 2
		}
	}
	return f
}

// unitRule is the units' bucket: units timed under -race are not mixed with plain ones.
func unitRule(run Run) string {
	return run.Runner + "|" + strings.Join(run.Flags, ",")
}

// workersFor is how many units the runner runs at once.
func (e *Estimator) workersFor(run Run) int {
	for _, flag := range run.Flags {
		name, value, _ := strings.Cut(flag, "=")
		if n, err := strconv.Atoi(value); err == nil && n > 0 && (name == "p" || name == "maxWorkers" || name == "n") {
			return n
		}
		if name == "runInBand" {
			return 1
		}
	}
	switch run.Runner {
	case "go":
		return e.workers
	case "vitest", "jest":
		return max(1, e.workers-1)
	}
	return 1
}

// defaultCalibration is the wall time over the units' makespan before any run measured it.
var defaultCalibration = map[string]float64{"go": 1.6, "vitest": 1.3, "jest": 1.5, "bun": 1.15, "cargo": 1.3}

// fromParts puts an estimate together from the run's units: their times, scheduled on the
// runner's lanes, times the runner's calibration. Every part of the scope must be known.
func (e *Estimator) fromParts(h *history, run Run) (Estimate, bool) {
	rule, factor := unitRule(run), 1.0
	units := h.Units[rule]
	if len(units) == 0 && len(run.Flags) > 0 {
		rule, factor = run.Runner+"|", flagFactor(run.Flags)
		units = h.Units[rule]
	}
	if len(units) == 0 {
		return Estimate{}, false
	}
	match := e.matcher(run)
	var times []float64
	var sumVar float64
	runs := 0
	for name, s := range units {
		if match(name) {
			times = append(times, s.Seconds())
			sumVar += s.Var
			runs = max(runs, s.N)
		}
	}
	if len(times) == 0 || !e.scopeCovered(run, units) {
		return Estimate{}, false
	}
	span := makespan(times, e.workersFor(run)) * factor
	cal := defaultCalibration[run.Runner]
	if cal == 0 {
		cal = 1.3
	}
	calMu, calSigma := math.Log(cal), sigmaParts
	if c := h.Calibration[rule]; c != nil && c.N > 0 {
		calMu, calSigma = c.Mu, c.Sigma(sigmaParts)
	}
	mu := math.Log(max(span, 0.01)) + calMu
	if run.Filter != "" {
		mu += math.Log(0.6) // a filter runs fewer tests than its units hold; the build stays
		calSigma += 0.3
	}
	sigma := math.Sqrt(calSigma*calSigma + sumVar/float64(len(times)))
	return lognormal(mu, sigma, "parts", runs), true
}

// scopeCovered reports that every part of a narrowed scope matched a known unit: a scope with a
// part never timed is not estimated from the parts that were.
func (e *Estimator) scopeCovered(run Run, units map[string]*Stat) bool {
	if run.Broad() {
		return true
	}
	for _, part := range run.Scope {
		one := run
		one.Scope = []string{part}
		match := e.matcher(one)
		found := false
		for name := range units {
			if match(name) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// matcher is which unit names a run's scope includes.
func (e *Estimator) matcher(run Run) func(string) bool {
	if run.Broad() || len(run.Scope) == 0 {
		return func(string) bool { return true }
	}
	if run.Runner == "go" {
		module := e.goModule(run.Dir)
		var exact, prefix []string
		for _, s := range run.Scope {
			p := s
			recursive := strings.HasSuffix(p, "/...")
			p = strings.TrimSuffix(p, "/...")
			if p == "." || strings.HasPrefix(p, "./") || strings.HasPrefix(p, "../") {
				if module == "" {
					continue
				}
				p = filepath.ToSlash(filepath.Join(module, p))
			}
			if recursive {
				prefix = append(prefix, p)
			} else {
				exact = append(exact, p)
			}
		}
		return func(name string) bool {
			for _, x := range exact {
				if name == x {
					return true
				}
			}
			for _, x := range prefix {
				if name == x || strings.HasPrefix(name, x+"/") {
					return true
				}
			}
			return false
		}
	}
	// Path runners filter by path: a unit is in scope when its path contains a scope part.
	return func(name string) bool {
		for _, s := range run.Scope {
			if strings.Contains(name, strings.TrimSuffix(s, "/")) {
				return true
			}
		}
		return false
	}
}

// goModule is the module path of the go.mod at or above dir.
func (e *Estimator) goModule(dir string) string {
	if m, ok := e.module[dir]; ok {
		return m
	}
	m := ""
	at := filepath.Join(e.root, dir)
	for range 8 {
		if f, err := os.Open(filepath.Join(at, "go.mod")); err == nil {
			scan := bufio.NewScanner(f)
			for scan.Scan() {
				if rest, ok := strings.CutPrefix(strings.TrimSpace(scan.Text()), "module "); ok {
					m = strings.Trim(strings.TrimSpace(rest), `"`)
					// A package directory below the module root reads relative to dir.
					if rel, err := filepath.Rel(at, filepath.Join(e.root, dir)); err == nil && rel != "." {
						m = filepath.ToSlash(filepath.Join(m, rel))
					}
					break
				}
			}
			f.Close()
			break
		}
		parent := filepath.Dir(at)
		if parent == at || !strings.HasPrefix(parent, e.root) {
			break
		}
		at = parent
	}
	e.module[dir] = m
	return m
}

// fromSimilar scales another run of the same runner: the whole suite, by the share of the test
// files the scope holds; otherwise the median of the runner's runs.
func (e *Estimator) fromSimilar(h *history, run Run) (Estimate, bool) {
	broad := run
	broad.Scope, broad.Filter, broad.Flags = nil, "", nil
	candidates := []string{broad.Key()}
	b := broad
	b.Scope = []string{"./..."}
	candidates = append(candidates, b.Key())
	b.Scope = []string{"."}
	candidates = append(candidates, b.Key())
	for _, key := range candidates {
		s := h.Runs[key]
		if s == nil || s.N == 0 {
			continue
		}
		share := 1.0
		if !run.Broad() {
			all, in := e.testFileShare(run)
			if all > 0 {
				share = max(float64(in)/float64(all), 0.05)
			} else {
				share = 0.3
			}
			if run.Filter != "" {
				share *= 0.6
			}
		}
		// Start-up does not shrink with the scope: a third of the whole run's time is kept.
		seconds := s.Seconds() * (1.0/3 + 2.0/3*share) * flagFactor(run.Flags)
		return lognormal(math.Log(seconds), sigmaSimilar, "similar", s.N), true
	}
	// Any run of this runner, the median of their medians.
	var mus []float64
	runs := 0
	prefix := run.Runner + "|" + run.Dir + "|"
	for key, s := range h.Runs {
		if strings.HasPrefix(key, prefix) && s.N > 0 {
			mus = append(mus, s.Mu)
			runs += s.N
		}
	}
	if len(mus) == 0 {
		return Estimate{}, false
	}
	sortDesc(mus)
	return lognormal(mus[len(mus)/2]+math.Log(flagFactor(run.Flags)), sigmaSimilar+0.2, "similar", runs), true
}

// priors are a runner's start-up and its cost per test file, in seconds, before any run.
var priors = map[string][2]float64{
	"go": {3, 0.8}, "vitest": {1.5, 0.4}, "jest": {2, 0.6}, "bun": {0.3, 0.08}, "pytest": {1, 0.25},
	"cargo": {8, 0.3}, "deno": {1, 0.2}, "mocha": {1, 0.2}, "rspec": {2, 0.3}, "phpunit": {1, 0.3},
	"dotnet": {6, 0.5}, "gradle": {10, 0.5}, "maven": {12, 0.5}, "swift": {6, 0.5},
}

// guess is the prior: start-up plus each test file in scope, over the runner's lanes.
func (e *Estimator) guess(run Run) Estimate {
	prior, ok := priors[run.Runner]
	if !ok {
		prior = [2]float64{3, 0.5}
	}
	_, in := e.testFileShare(run)
	seconds := (prior[0] + prior[1]*float64(in)/float64(e.workersFor(run))) * flagFactor(run.Flags)
	return lognormal(math.Log(seconds), sigmaGuess, "guess", 0)
}

// Bounds on the walk for the prior: it is a guess, and must stay cheap in a huge tree.
const (
	maxWalk   = 20000
	filesKept = 2 * time.Minute
)

var skipDirs = map[string]bool{".git": true, "node_modules": true, "vendor": true, "dist": true, "build": true, "target": true, ".archymedes": true, ".venv": true, "venv": true, "__pycache__": true, ".next": true, "coverage": true, ".cache": true}

// testFileShare is how many test files the project has, and how many of them the run's scope
// holds. For Go it counts packages: directories with a _test.go file.
func (e *Estimator) testFileShare(run Run) (all, in int) {
	files := e.testFiles()
	match := e.pathMatcher(run)
	seen := map[string]bool{}
	for _, f := range files {
		unit := f
		if run.Runner == "go" {
			if !strings.HasSuffix(f, "_test.go") {
				continue
			}
			unit = filepath.ToSlash(filepath.Dir(f))
		} else if strings.HasSuffix(f, "_test.go") {
			continue
		}
		if run.Dir != "" && !strings.HasPrefix(unit, run.Dir+"/") && unit != run.Dir {
			continue
		}
		if seen[unit] {
			continue
		}
		seen[unit] = true
		all++
		if match(strings.TrimPrefix(strings.TrimPrefix(unit, run.Dir), "/")) {
			in++
		}
	}
	return all, in
}

// pathMatcher is which project-relative paths (below the run's directory) its scope includes.
func (e *Estimator) pathMatcher(run Run) func(string) bool {
	if run.Broad() || len(run.Scope) == 0 {
		return func(string) bool { return true }
	}
	return func(p string) bool {
		for _, s := range run.Scope {
			s = strings.TrimPrefix(s, "./")
			recursive := strings.HasSuffix(s, "/...")
			s = strings.TrimSuffix(strings.TrimSuffix(s, "/..."), "/")
			switch {
			case s == "" || s == ".":
				if recursive || p == "." {
					return true
				}
			case p == s, recursive && strings.HasPrefix(p, s+"/"):
				return true
			case run.Runner != "go" && strings.Contains(p, s):
				return true
			}
		}
		return false
	}
}

// testFiles is the project's test files, walked at most every filesKept.
func (e *Estimator) testFiles() []string {
	if e.files != nil && time.Since(e.filesAt) < filesKept {
		return e.files
	}
	files := []string{}
	visited := 0
	_ = filepath.WalkDir(e.root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		visited++
		if visited > maxWalk {
			return filepath.SkipAll
		}
		if d.IsDir() {
			if path != e.root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if IsTestFile(d.Name()) {
			if rel, err := filepath.Rel(e.root, path); err == nil {
				files = append(files, filepath.ToSlash(rel))
			}
		}
		return nil
	})
	e.files, e.filesAt = files, time.Now()
	return files
}

// IsTestFile says whether a file's name is a test file's in any of the runners Friday knows.
func IsTestFile(name string) bool {
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, "_test.go"), strings.HasSuffix(lower, "_spec.rb"), strings.HasSuffix(lower, "_test.py"):
		return true
	case strings.HasPrefix(lower, "test_") && strings.HasSuffix(lower, ".py"):
		return true
	}
	for _, mid := range []string{".test.", ".spec.", "_test.", "_spec."} {
		if i := strings.Index(lower, mid); i > 0 {
			ext := lower[i+len(mid):]
			switch ext {
			case "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "rs", "dart", "exs":
				return true
			}
		}
	}
	return strings.HasSuffix(name, "Test.java") || strings.HasSuffix(name, "Tests.cs") || strings.HasSuffix(name, "Test.php") || strings.HasSuffix(name, "Tests.swift") || strings.HasSuffix(name, "Test.kt")
}
