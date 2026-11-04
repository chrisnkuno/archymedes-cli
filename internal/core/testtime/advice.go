package testtime

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Advice is what Friday knows about a test run before it starts: how long it will take, whether
// it can wait for the end of the work, and a narrower run over what changed.
type Advice struct {
	Run      Run
	Estimate Estimate
	// CanWait: a long run of the whole suite while the work is still changing code. Run the
	// narrower one while iterating and the whole suite once, at the end.
	CanWait bool
	// Narrower is a run over the changed code, "" when there is none to offer.
	Narrower         string
	NarrowerEstimate Estimate
}

// WaitAfter is how long a whole-suite run takes before it is worth leaving for the end.
const WaitAfter = 20.0

// Advise reads command as a test run and says what is known about it. written are the files the
// session changed, relative to the project root. ok is false when the command runs no tests.
func (e *Estimator) Advise(command string, written []string) (Advice, bool) {
	run, ok := Detect(command)
	if !ok {
		return Advice{}, false
	}
	a := Advice{Run: run, Estimate: e.Estimate(run)}
	if !run.Broad() || len(written) == 0 || a.Estimate.P50 < WaitAfter {
		return a, true
	}
	a.CanWait = true
	if scope := narrowScope(run, written); len(scope) > 0 {
		narrow := run
		narrow.Scope, narrow.Filter = scope, ""
		est := e.Estimate(narrow)
		if est.P50 < a.Estimate.P50*0.6 {
			a.Narrower, a.NarrowerEstimate = narrowCommand(run, scope), est
		}
	}
	return a, true
}

// maxNarrow is how many packages or files a narrower run names before it is not narrow.
const maxNarrow = 6

// narrowScope is the part of the suite the written files touch: their Go packages, or the test
// files among them for a runner that takes files.
func narrowScope(run Run, written []string) []string {
	var scope []string
	for _, f := range written {
		rel := f
		if run.Dir != "" {
			cut, ok := strings.CutPrefix(f, run.Dir+"/")
			if !ok {
				continue
			}
			rel = cut
		}
		switch run.Runner {
		case "go":
			if strings.HasSuffix(rel, ".go") {
				dir := filepath.ToSlash(filepath.Dir(rel))
				if dir == "." {
					scope = append(scope, ".")
				} else {
					scope = append(scope, "./"+dir)
				}
			}
		case "vitest", "jest", "bun", "pytest", "mocha", "deno", "rspec", "phpunit":
			if IsTestFile(filepath.Base(rel)) {
				scope = append(scope, rel)
			}
		}
	}
	slices.Sort(scope)
	scope = slices.Compact(scope)
	if len(scope) > maxNarrow {
		return nil
	}
	return scope
}

func narrowCommand(run Run, scope []string) string {
	parts := []string{run.Base}
	for _, s := range scope {
		if strings.ContainsAny(s, " \t'\"$`\\") {
			s = "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
		}
		parts = append(parts, s)
	}
	command := strings.Join(parts, " ")
	if run.Dir != "" {
		command = "cd " + run.Dir + " && " + command
	}
	return command
}

// Data is the advice as the tool card reads it (`testRun` in a run_command call's data).
func (a Advice) Data() map[string]any {
	data := map[string]any{
		"runner": a.Run.Runner, "broad": a.Run.Broad(),
		"p50": round1(a.Estimate.P50), "p90": round1(a.Estimate.P90), "basis": a.Estimate.Basis, "runs": a.Estimate.Runs,
	}
	if a.CanWait {
		data["canWait"] = true
	}
	if a.Narrower != "" {
		data["narrower"], data["narrowerP50"] = a.Narrower, round1(a.NarrowerEstimate.P50)
	}
	return data
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// Duration is seconds as people read them: "800ms", "12s", "1m 40s", "about 2h".
func Duration(seconds float64) string {
	switch {
	case seconds < 1:
		return fmt.Sprintf("%dms", int(math.Round(seconds*1000)))
	case seconds < 60:
		return fmt.Sprintf("%ds", int(math.Round(seconds)))
	case seconds < 3600:
		m, s := int(seconds)/60, int(math.Round(seconds))%60
		if s == 0 {
			return fmt.Sprintf("%dm", m)
		}
		return fmt.Sprintf("%dm %ds", m, s)
	}
	return fmt.Sprintf("about %dh", int(math.Round(seconds/3600)))
}

// Note is what the model is told after the run, "" when there is nothing worth the words: a
// short run that went as expected.
func (a Advice) Note(took float64) string {
	var parts []string
	expected := ""
	if a.Estimate.Trusted() {
		expected = fmt.Sprintf(" (expected ≈%s from %s)", Duration(a.Estimate.P50), plural(a.Estimate.Runs, "earlier run"))
	}
	if took >= 5 || a.CanWait {
		parts = append(parts, fmt.Sprintf("Tests took %s%s.", Duration(took), expected))
	}
	if a.CanWait {
		line := "This whole suite can wait for the end of the work"
		if a.Narrower != "" {
			line += fmt.Sprintf(": while iterating, `%s` covers the changed code in ≈%s", a.Narrower, Duration(a.NarrowerEstimate.P50))
		}
		parts = append(parts, line+"; run the whole suite once before finishing.")
	}
	if len(parts) == 0 {
		return ""
	}
	return "[" + strings.Join(parts, " ") + "]"
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// TimeoutFor is how long to let a run go when the caller named no limit: the default, or, when
// this project measured the run longer than that, its 90th percentile with room to spare, so a
// suite known to take three minutes is not killed at two and run again.
func (a Advice) TimeoutFor(def, ceiling time.Duration) time.Duration {
	if !a.Estimate.Trusted() {
		return def
	}
	need := time.Duration((a.Estimate.P90*1.5 + 10) * float64(time.Second))
	if need <= def {
		return def
	}
	return min(need.Round(time.Second), ceiling)
}

// Record folds a finished run into the history: its time, and its units' times from its output.
// A run killed at its limit is a lower bound: it counts only when it says the run is slower than
// believed. A cancelled run says nothing.
func (e *Estimator) Record(run Run, took time.Duration, output string, timedOut bool) {
	seconds := took.Seconds()
	now := time.Now()
	e.mu.Lock()
	h := e.load()
	s := statFor(h.Runs, run.Key())
	if !timedOut || s.N == 0 || seconds > s.Seconds() {
		s.Add(seconds, now)
	}
	if !timedOut {
		units := parseUnits(run.Runner, output)
		rule := unitRule(run)
		var times []float64
		cached := false
		for _, u := range units {
			if u.Cached {
				cached = true
				continue
			}
			h.unit(rule, u.Name).Add(u.Seconds, now)
			times = append(times, u.Seconds)
		}
		// The calibration is the wall time over the makespan of what really ran; a run with cached
		// packages took less than its units would, and would teach it wrong.
		if !cached && len(times) > 0 {
			if span := makespan(times, e.workersFor(run)); span > 0.05 {
				statFor(h.Calibration, rule).Add(seconds/span, now)
			}
		}
	}
	h.evict()
	_ = h.save(e.path)
	e.mu.Unlock()
}

// pass is a run that passed in this process, kept to answer the same run on the same tree.
type pass struct {
	print   string
	at      time.Time
	took    time.Duration
	content string
}

// ReuseWithin is how long a pass may stand in for a new run of the same tests on the same tree.
const ReuseWithin = 30 * time.Minute

// maxKeptOutput is how much of a passing run's output is kept to be shown again.
const maxKeptOutput = 32_000

// Reused is an earlier pass of the same command (key: its words) on the very same tree: what it printed, how long it
// took and when. ok is false when there is none, the tree changed, or Friday cannot tell.
func (e *Estimator) Reused(key, print string) (content string, took time.Duration, at time.Time, ok bool) {
	if print == "" {
		return "", 0, time.Time{}, false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	p, found := e.passes[key]
	if !found || p.print != print || time.Since(p.at) > ReuseWithin {
		return "", 0, time.Time{}, false
	}
	return p.content, p.took, p.at, true
}

// Passed remembers a pass on the tree with fingerprint print.
func (e *Estimator) Passed(key, print, content string, took time.Duration) {
	if print == "" {
		return
	}
	if len(content) > maxKeptOutput {
		content = content[:maxKeptOutput/2] + "\n[…]\n" + content[len(content)-maxKeptOutput/2:]
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.passes[key] = pass{print: print, at: time.Now(), took: took, content: content}
}

// Forget drops the pass of a command that has since failed: a flaky suite is not answered from a
// pass the tree no longer earns.
func (e *Estimator) Forget(key string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.passes, key)
}

// maxPrinted is how many changed paths a fingerprint stats; past it, Friday cannot tell cheaply.
const maxPrinted = 5000

// Fingerprint names the state of the work tree: the commit, every changed or untracked path, and
// each one's size and modification time. Friday's own folder (.archymedes: sessions, this history)
// is left out, since it changes on every run whether or not the code did. Two equal fingerprints are the same tree for tests (files
// git ignores aside). "" outside git, or when git does not answer within a second or two.
func (e *Estimator) Fingerprint(ctx context.Context) string {
	top := e.topLevel(ctx)
	if top == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", ".", ":(glob,exclude)**/.archymedes/**")
	cmd.Dir = e.root
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	h := sha256.New()
	h.Write(out)
	records := strings.Split(string(out), "\x00")
	var buf [16]byte
	printed := 0
	for i := 0; i < len(records); i++ {
		path := statusPath(records[i])
		if strings.HasPrefix(records[i], "2 ") {
			i++ // a rename's next record is its old path
		}
		if path == "" {
			continue
		}
		printed++
		if printed > maxPrinted {
			return ""
		}
		info, err := os.Lstat(filepath.Join(top, filepath.FromSlash(path)))
		if err != nil {
			h.Write([]byte{0})
			continue
		}
		binary.LittleEndian.PutUint64(buf[:8], uint64(info.Size()))
		binary.LittleEndian.PutUint64(buf[8:], uint64(info.ModTime().UnixNano()))
		h.Write(buf[:])
	}
	return hex.EncodeToString(h.Sum(nil)[:12])
}

// statusPath is the path of one `git status --porcelain=v2 -z` record, "" for a header.
func statusPath(record string) string {
	fields := 0
	switch {
	case strings.HasPrefix(record, "1 "):
		fields = 8
	case strings.HasPrefix(record, "2 "):
		fields = 9
	case strings.HasPrefix(record, "u "):
		fields = 10
	case strings.HasPrefix(record, "? "):
		return record[2:]
	default:
		return ""
	}
	rest := record
	for range fields {
		_, after, ok := strings.Cut(rest, " ")
		if !ok {
			return ""
		}
		rest = after
	}
	return rest
}

func (e *Estimator) topLevel(ctx context.Context) string {
	e.mu.Lock()
	top := e.toplvl
	e.mu.Unlock()
	if top == "" {
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "git", "rev-parse", "--show-toplevel")
		cmd.Dir = e.root
		top = "-"
		if out, err := cmd.Output(); err == nil {
			top = strings.TrimSpace(string(out))
		} else if ctx.Err() != nil {
			return "" // slow, not absent: ask again next time
		}
		e.mu.Lock()
		e.toplvl = top
		e.mu.Unlock()
	}
	if top == "-" {
		return ""
	}
	return top
}
