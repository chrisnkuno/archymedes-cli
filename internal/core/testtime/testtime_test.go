package testtime

import (
	"context"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDetectReadsRunnersScopeAndFlags(t *testing.T) {
	cases := []struct {
		command, runner, dir string
		scope                []string
		filter               string
		flags                []string
		broad                bool
	}{
		{"go test ./...", "go", "", []string{"./..."}, "", nil, true},
		{"go test -v ./... -race", "go", "", []string{"./..."}, "", []string{"race"}, true},
		{"go test -count=1 ./internal/core/tools", "go", "", []string{"./internal/core/tools"}, "", nil, false},
		{"go test -run TestX ./pkg", "go", "", []string{"./pkg"}, "TestX", nil, false},
		{"cd packages/app && npx vitest run src/a.test.ts", "vitest", "packages/app", []string{"src/a.test.ts"}, "", nil, false},
		{"python -m pytest -k slow tests/", "pytest", "", []string{"tests/"}, "slow", nil, false},
		{"pytest", "pytest", "", nil, "", nil, true},
		{"npm test", "script:npm:test", "", nil, "", nil, true},
		{"npm run test:unit -- src/x", "script:npm:test:unit", "", []string{"src/x"}, "", nil, false},
		{"pnpm vitest --run", "vitest", "", nil, "", nil, true},
		{"npx vitest run", "vitest", "", nil, "", nil, true},
		{"cargo test parser -- --nocapture", "cargo", "", nil, "parser --nocapture", nil, false},
		{"CI=1 bun test", "bun", "", nil, "", nil, true},
		{"go vet ./... && go test ./...", "go", "", []string{"./..."}, "", nil, true},
		{"make test", "script:make:test", "", nil, "", nil, true},
		{"timeout 300 go test ./...", "go", "", []string{"./..."}, "", nil, true},
	}
	for _, c := range cases {
		run, ok := Detect(c.command)
		if !ok {
			t.Errorf("%q: not read as a test run", c.command)
			continue
		}
		if run.Runner != c.runner || run.Dir != c.dir || strings.Join(run.Scope, ",") != strings.Join(c.scope, ",") || run.Filter != c.filter || strings.Join(run.Flags, ",") != strings.Join(c.flags, ",") {
			t.Errorf("%q: got %+v", c.command, run)
		}
		if run.Broad() != c.broad {
			t.Errorf("%q: broad = %v", c.command, run.Broad())
		}
	}
	for _, command := range []string{"ls tests", "cat app_test.go", "go build ./...", "echo test", "git log --grep test", "bun test --watch", "npm run build"} {
		if run, ok := Detect(command); ok {
			t.Errorf("%q: read as a test run: %+v", command, run)
		}
	}
}

func TestSameTestsShareAKey(t *testing.T) {
	a, _ := Detect("go test -v ./... -race")
	b, _ := Detect("go test -race ./... -v")
	c, _ := Detect("go test ./...")
	if a.Key() != b.Key() {
		t.Errorf("flag order changed the key: %q vs %q", a.Key(), b.Key())
	}
	if a.Key() == c.Key() {
		t.Error("-race should be its own run")
	}
}

func TestStatLearnsAndAdapts(t *testing.T) {
	var s Stat
	now := time.Now()
	for range 5 {
		s.Add(10, now)
	}
	if math.Abs(s.Seconds()-10) > 0.01 || s.Var > 1e-9 {
		t.Fatalf("five runs of 10s: median %v, var %v", s.Seconds(), s.Var)
	}
	// The suite got three times slower: within three runs the median is past 20s.
	for range 3 {
		s.Add(30, now)
	}
	if s.Seconds() < 20 {
		t.Errorf("after three slow runs the median is still %v", s.Seconds())
	}
	if s.Sigma(sigmaHistory) <= 0 {
		t.Error("a spread of zero after a change")
	}
}

func TestMakespanSchedulesLongestFirst(t *testing.T) {
	if got := makespan([]float64{1, 2, 3}, 1); got != 6 {
		t.Errorf("one lane: %v", got)
	}
	if got := makespan([]float64{1, 2, 3}, 8); got != 3 {
		t.Errorf("enough lanes: %v", got)
	}
	// 7,5,4,3,1 on two lanes: LPT gives 7+3=10 and 5+4+1=10.
	if got := makespan([]float64{3, 7, 1, 5, 4}, 2); got != 10 {
		t.Errorf("two lanes: %v", got)
	}
}

const goOutput = "ok  \texample.com/app/a\t2.000s\nok  \texample.com/app/b\t4.000s\nFAIL\texample.com/app/c\t1.500s\nok  \texample.com/app/d\t(cached)\n"

func TestParseUnitsPerRunner(t *testing.T) {
	units := parseUnits("go", goOutput)
	if len(units) != 4 || units[1].Name != "example.com/app/b" || units[1].Seconds != 4 || !units[3].Cached {
		t.Errorf("go: %+v", units)
	}
	vitest := " ✓ src/a.test.ts (5 tests) 123ms\n ❯ src/b.test.ts (3 tests | 1 failed) 1.20s\n"
	if u := parseUnits("vitest", vitest); len(u) != 2 || math.Abs(u[0].Seconds-0.123) > 1e-9 || u[1].Seconds != 1.2 {
		t.Errorf("vitest: %+v", u)
	}
	if u := parseUnits("jest", "PASS src/a.test.ts (1.5 s)\nFAIL src/b.test.ts (250 ms)\nPASS src/c.test.ts\n"); len(u) != 2 || u[1].Seconds != 0.25 {
		t.Errorf("jest: %+v", u)
	}
	bun := "src/a.test.ts:\n(pass) adds [1.50ms]\n(pass) subtracts [0.50ms]\n\nsrc/b.test.ts:\n(fail) breaks [2.00ms]\n"
	if u := parseUnits("bun", bun); len(u) != 2 || math.Abs(u[0].Seconds-0.002) > 1e-9 {
		t.Errorf("bun: %+v", u)
	}
	cargo := "     Running unittests src/lib.rs (target/debug/deps/app-1a2b)\ntest result: ok. 3 passed; 0 failed; finished in 0.42s\n"
	if u := parseUnits("cargo", cargo); len(u) != 1 || u[0].Seconds != 0.42 {
		t.Errorf("cargo: %+v", u)
	}
	if u := parseUnits("script:npm:test", vitest); len(u) != 2 {
		t.Errorf("a package script running vitest: %+v", u)
	}
}

// project is a throwaway Go module with three packages of tests.
func project(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("go.mod", "module example.com/app\n\ngo 1.24\n")
	for _, p := range []string{"a", "b", "c"} {
		write(p+"/x.go", "package "+p+"\n")
		write(p+"/x_test.go", "package "+p+"\n")
	}
	return root
}

func TestEstimateFallsFromHistoryToPartsToSimilarToGuess(t *testing.T) {
	root := project(t)
	e := For(root)
	all, _ := Detect("go test ./...")
	one, _ := Detect("go test ./b")
	if est := e.Estimate(one); est.Basis != "guess" || est.P50 <= 0 || est.P90 <= est.P50 {
		t.Fatalf("no runs yet: %+v", est)
	}
	e.Record(all, 9*time.Second, goOutput, false)
	if est := e.Estimate(all); est.Basis != "history" || math.Abs(est.P50-9) > 0.01 || est.Runs != 1 {
		t.Errorf("after one run, the same run: %+v", est)
	}
	// ./b alone: never run, but its package was timed at 4s inside the whole run.
	est := e.Estimate(one)
	if est.Basis != "parts" {
		t.Fatalf("a package timed before: %+v", est)
	}
	if est.P50 < 4 || est.P50 > 9 {
		t.Errorf("./b should take more than its 4s of tests and less than the 9s suite: %+v", est)
	}
	// A package never timed is not estimated from the others' parts.
	other, _ := Detect("go test ./nowhere")
	if est := e.Estimate(other); est.Basis == "parts" {
		t.Errorf("an unknown package from parts: %+v", est)
	}
	// Different flags, nothing measured under them: from the plain parts, three times slower.
	race, _ := Detect("go test -race ./b")
	if r := e.Estimate(race); r.Basis != "parts" || r.P50 < est.P50*2.5 {
		t.Errorf("-race: %+v against %+v", r, est)
	}
}

func TestHistorySurvivesARestart(t *testing.T) {
	root := project(t)
	run, _ := Detect("go test ./...")
	For(root).Record(run, 30*time.Second, "", false)
	fresh := &Estimator{root: root, path: HistoryPath(root), module: map[string]string{}, passes: map[string]pass{}, workers: 4}
	if est := fresh.Estimate(run); est.Basis != "history" || math.Abs(est.P50-30) > 0.01 {
		t.Errorf("read back: %+v", est)
	}
	// A damaged file is started over, not trusted.
	if err := os.WriteFile(HistoryPath(root), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	broken := &Estimator{root: root, path: HistoryPath(root), module: map[string]string{}, passes: map[string]pass{}, workers: 4}
	if est := broken.Estimate(run); est.Basis == "history" {
		t.Errorf("damaged file trusted: %+v", est)
	}
}

func TestATimedOutRunOnlyRaisesTheEstimate(t *testing.T) {
	root := project(t)
	e := For(root)
	run, _ := Detect("go test ./a")
	e.Record(run, 60*time.Second, "", false)
	e.Record(run, 10*time.Second, "", true) // killed early by a short limit: says nothing
	if est := e.Estimate(run); math.Abs(est.P50-60) > 0.01 {
		t.Errorf("a short timeout lowered it: %+v", est)
	}
	e.Record(run, 120*time.Second, "", true)
	if est := e.Estimate(run); est.P50 <= 60 {
		t.Errorf("a run killed past the median did not raise it: %+v", est)
	}
}

func TestAdviseLeavesALongSuiteForTheEnd(t *testing.T) {
	root := project(t)
	e := For(root)
	all, _ := Detect("go test ./...")
	e.Record(all, 45*time.Second, "ok  \texample.com/app/a\t30.000s\nok  \texample.com/app/b\t1.000s\nok  \texample.com/app/c\t2.000s\n", false)

	a, ok := e.Advise("go test ./...", []string{"b/x.go", "README.md"})
	if !ok || !a.CanWait {
		t.Fatalf("a 45s suite with changed code: %+v", a)
	}
	if a.Narrower != "go test ./b" || a.NarrowerEstimate.P50 >= 10 {
		t.Errorf("narrower: %q %+v", a.Narrower, a.NarrowerEstimate)
	}
	note := a.Note(44)
	for _, want := range []string{"44s", "expected ≈45s", "can wait for the end", "`go test ./b`"} {
		if !strings.Contains(note, want) {
			t.Errorf("note %q lacks %q", note, want)
		}
	}
	if data := a.Data(); data["canWait"] != true || data["narrower"] != "go test ./b" || data["basis"] != "history" {
		t.Errorf("data: %v", data)
	}
	// Nothing changed yet, or a narrow run, or a short suite: nothing to leave for later.
	if a, _ := e.Advise("go test ./...", nil); a.CanWait {
		t.Error("nothing written, yet told to wait")
	}
	if a, _ := e.Advise("go test ./b", []string{"b/x.go"}); a.CanWait {
		t.Error("a narrow run told to wait")
	}
	if _, ok := e.Advise("go build ./...", nil); ok {
		t.Error("a build advised as tests")
	}
}

func TestTimeoutGrowsOnlyForAMeasuredLongRun(t *testing.T) {
	def, ceiling := 120*time.Second, 30*time.Minute
	long := Advice{Estimate: Estimate{P50: 150, P90: 200, Basis: "history", Runs: 3}}
	if got := long.TimeoutFor(def, ceiling); got != 310*time.Second {
		t.Errorf("a 200s p90: %v", got)
	}
	guessed := Advice{Estimate: Estimate{P50: 150, P90: 600, Basis: "guess"}}
	if got := guessed.TimeoutFor(def, ceiling); got != def {
		t.Errorf("a guess moved the limit: %v", got)
	}
	short := Advice{Estimate: Estimate{P50: 5, P90: 8, Basis: "history", Runs: 3}}
	if got := short.TimeoutFor(def, ceiling); got != def {
		t.Errorf("a short run lowered the limit: %v", got)
	}
	huge := Advice{Estimate: Estimate{P50: 5000, P90: 9000, Basis: "history", Runs: 3}}
	if got := huge.TimeoutFor(def, ceiling); got != ceiling {
		t.Errorf("past the ceiling: %v", got)
	}
}

func TestFingerprintFollowsTheTree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := project(t)
	e := For(root)
	if e.Fingerprint(context.Background()) != "" {
		t.Fatal("a fingerprint outside git")
	}
	git := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "user.email=t@t", "-c", "user.name=t"}, args...)...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	git("init", "-q")
	git("add", ".")
	git("commit", "-qm", "start")
	e2 := &Estimator{root: root, path: HistoryPath(root), module: map[string]string{}, passes: map[string]pass{}, workers: 4}
	first := e2.Fingerprint(context.Background())
	if first == "" || first != e2.Fingerprint(context.Background()) {
		t.Fatalf("not stable: %q", first)
	}
	e2.Passed("go test ./...", first, "exit 0\nok", time.Second)
	if _, _, _, ok := e2.Reused("go test ./...", first); !ok {
		t.Error("the same tree did not reuse the pass")
	}
	if err := os.WriteFile(filepath.Join(root, "a", "x.go"), []byte("package a\n\nvar X = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	second := e2.Fingerprint(context.Background())
	if second == first {
		t.Fatal("an edit did not change the fingerprint")
	}
	if _, _, _, ok := e2.Reused("go test ./...", second); ok {
		t.Error("a changed tree reused the pass")
	}
	// Edited again, to a new size: an already-modified file changing again changes it too.
	if err := os.WriteFile(filepath.Join(root, "a", "x.go"), []byte("package a\n\nvar X = 22\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if third := e2.Fingerprint(context.Background()); third == second {
		t.Error("a second edit of a modified file did not change it")
	}
}

func TestStatusPath(t *testing.T) {
	cases := map[string]string{
		"1 .M N... 100644 100644 100644 abc def a/x.go":      "a/x.go",
		"2 R. N... 100644 100644 100644 abc def R100 b/y.go": "b/y.go",
		"? new file.txt":                  "new file.txt",
		"# branch.oid 0123456789abcdef":   "",
		"u UU N... 1 2 3 4 h1 h2 h3 c.go": "c.go",
	}
	for record, want := range cases {
		if got := statusPath(record); got != want {
			t.Errorf("%q: %q, want %q", record, got, want)
		}
	}
}

func TestDuration(t *testing.T) {
	for seconds, want := range map[float64]string{0.25: "250ms", 12.4: "12s", 100: "1m 40s", 120: "2m", 7200: "about 2h"} {
		if got := Duration(seconds); got != want {
			t.Errorf("%v: %q, want %q", seconds, got, want)
		}
	}
}

func TestIsTestFile(t *testing.T) {
	for _, name := range []string{"x_test.go", "a.test.ts", "b.spec.tsx", "test_app.py", "app_test.py", "user_spec.rb", "FooTest.java"} {
		if !IsTestFile(name) {
			t.Errorf("%s is a test file", name)
		}
	}
	for _, name := range []string{"x.go", "test.ts", "latest.json", "contest.py", "README.md"} {
		if IsTestFile(name) {
			t.Errorf("%s is not a test file", name)
		}
	}
}
