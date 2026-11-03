package testtime

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// A unit is the part of a run its runner schedules on its own and times: a Go package, a test
// file, a Rust test binary. Units are what make an estimate for a scope never run before: the
// sum of its parts, scheduled the way the runner schedules them.

// unitTime is one unit's time in one run. Cached is a Go package whose result came from the cache.
type unitTime struct {
	Name    string
	Seconds float64
	Cached  bool
}

var (
	// ok  	github.com/x/y/pkg	0.123s    FAIL	github.com/x/y/pkg	1.2s    ok  	pkg	(cached)
	goUnit = regexp.MustCompile(`(?m)^(?:ok|FAIL)\s+(\S+)\s+(?:(\d+(?:\.\d+)?)s|\(cached\))`)
	// ✓ src/a.test.ts (5 tests) 123ms     ❯ src/b.test.ts (3 tests | 1 failed) 1.20s
	vitestUnit = regexp.MustCompile(`(?m)^\s*(?:✓|✗|×|❯|√|↓)\s+(\S+)\s+\(\d+ tests?[^)]*\)\s*(?:\d+ skipped\s*)?(\d+(?:\.\d+)?)(ms|s)\b`)
	// PASS src/a.test.ts (1.234 s)    FAIL src/b.test.ts (12.5 s)
	jestUnit = regexp.MustCompile(`(?m)^\s*(?:PASS|FAIL)\s+(\S+)\s+\((\d+(?:\.\d+)?)\s*(m?s)\)`)
	// bun test prints a file's name on its own line, then each test with its time.
	bunFile = regexp.MustCompile(`^(\S+\.(?:test|spec|_test|_spec)\.[cm]?[jt]sx?):$`)
	bunTest = regexp.MustCompile(`^\((?:pass|fail)\).*\[(\d+(?:\.\d+)?)(ms|s)\]\s*$`)
	// Running unittests src/lib.rs (target/debug/deps/app-1a2b3c)   ... finished in 0.42s
	cargoRunning = regexp.MustCompile(`^\s*Running (?:unittests )?(\S+)`)
	cargoResult  = regexp.MustCompile(`^test result: .*finished in (\d+(?:\.\d+)?)s`)
)

// parseUnits reads the units a runner's output timed. Units it cannot see are left out; a runner
// that prints none (pytest without --durations) gives none, and the run's own time still counts.
func parseUnits(runner, output string) []unitTime {
	switch runner {
	case "go":
		var out []unitTime
		for _, m := range goUnit.FindAllStringSubmatch(output, -1) {
			if m[2] == "" {
				out = append(out, unitTime{Name: m[1], Cached: true})
				continue
			}
			s, _ := strconv.ParseFloat(m[2], 64)
			out = append(out, unitTime{Name: m[1], Seconds: s})
		}
		return out
	case "vitest":
		return byPattern(vitestUnit, output)
	case "jest":
		return byPattern(jestUnit, output)
	case "bun":
		return parseBun(output)
	case "cargo":
		return parseCargo(output)
	}
	if strings.HasPrefix(runner, "script:") {
		// A package script runs one of the above; whichever prints, reads.
		for _, r := range []string{"vitest", "jest", "go", "bun"} {
			if units := parseUnits(r, output); len(units) > 0 {
				return units
			}
		}
	}
	return nil
}

func byPattern(pattern *regexp.Regexp, output string) []unitTime {
	var out []unitTime
	for _, m := range pattern.FindAllStringSubmatch(output, -1) {
		out = append(out, unitTime{Name: m[1], Seconds: seconds(m[2], m[3])})
	}
	return out
}

func parseBun(output string) []unitTime {
	var out []unitTime
	current := -1
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if m := bunFile.FindStringSubmatch(line); m != nil {
			out = append(out, unitTime{Name: m[1]})
			current = len(out) - 1
			continue
		}
		if m := bunTest.FindStringSubmatch(line); m != nil && current >= 0 {
			out[current].Seconds += seconds(m[1], m[2])
		}
	}
	return out
}

func parseCargo(output string) []unitTime {
	var out []unitTime
	name := ""
	for _, line := range strings.Split(output, "\n") {
		if m := cargoRunning.FindStringSubmatch(line); m != nil {
			name = m[1]
			continue
		}
		if m := cargoResult.FindStringSubmatch(line); m != nil && name != "" {
			s, _ := strconv.ParseFloat(m[1], 64)
			out = append(out, unitTime{Name: name, Seconds: s})
			name = ""
		}
	}
	return out
}

func seconds(value, unit string) float64 {
	v, _ := strconv.ParseFloat(value, 64)
	if unit == "ms" {
		return v / 1000
	}
	return v
}

// makespan is how long units take on workers parallel lanes, as the runner schedules them:
// longest first, each to the lane that frees up soonest (LPT; within 4/3 of the best schedule).
// One lane is their sum; enough lanes is the longest.
func makespan(times []float64, workers int) float64 {
	if len(times) == 0 {
		return 0
	}
	if workers <= 1 {
		total := 0.0
		for _, t := range times {
			total += t
		}
		return total
	}
	sorted := append([]float64{}, times...)
	sortDesc(sorted)
	if workers >= len(sorted) {
		return sorted[0]
	}
	lanes := make([]float64, workers)
	for _, t := range sorted {
		least := 0
		for i := 1; i < workers; i++ {
			if lanes[i] < lanes[least] {
				least = i
			}
		}
		lanes[least] += t
	}
	longest := lanes[0]
	for _, l := range lanes[1:] {
		longest = max(longest, l)
	}
	return longest
}

func sortDesc(v []float64) {
	slices.Sort(v)
	slices.Reverse(v)
}
