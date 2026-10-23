package gate

import (
	"reflect"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

func write(file string) Record {
	return Record{ToolName: "write_file", Args: tool.Args{"path": file}, Effect: tool.EffectWorkspace}
}

func passed(kind tool.EvidenceKind) Record {
	return Record{ToolName: "run_command", Args: tool.Args{"command": string(kind)}, Effect: tool.EffectNone, Evidence: &tool.Evidence{Passed: true, Kind: kind, Summary: string(kind)}}
}

var failedTests = Record{ToolName: "run_command", Args: tool.Args{"command": "npm test"}, Effect: tool.EffectNone, IsError: true, Data: map[string]any{"verificationKind": "tests", "exitCode": 1}}

// drain asks the gate until it lets the run finish; the requests it made, in order.
func drain(g *Gate) []string {
	asked := []string{}
	for next := g.BeforeFinish(); next != ""; next = g.BeforeFinish() {
		asked = append(asked, next)
	}
	return asked
}

func expectOne(t *testing.T, asked []string, contains string) {
	t.Helper()
	if len(asked) != 1 || !strings.Contains(asked[0], contains) {
		t.Fatalf("asked %q, want one request containing %q", asked, contains)
	}
}

func TestTestPaths(t *testing.T) {
	for _, file := range []string{"src/app.test.ts", "src/app.spec.tsx", "internal/tui/core_view_test.go", "tests/test_parser.py", "test_parser.py",
		"spec/models/user_spec.rb", "src/__tests__/app.ts", "e2e/login.ts", "src/test/java/AppTest.java", `C:\repo\tests\a.py`} {
		if got := ClassifyPath(file); got != "test" {
			t.Errorf("%s: %s, want test", file, got)
		}
	}
}

func TestCodePaths(t *testing.T) {
	for _, file := range []string{"src/app.ts", "cmd/friday/main.go", "lib/parser.py", "src/App.vue", "scripts/build.sh", "src/main.rs"} {
		if got := ClassifyPath(file); got != "code" {
			t.Errorf("%s: %s, want code", file, got)
		}
	}
}

func TestOtherPaths(t *testing.T) {
	for _, file := range []string{"README.md", "package.json", "src/styles.css", "docs/testing.md", ".github/workflows/ci.yml", "index.html"} {
		if got := ClassifyPath(file); got != "other" {
			t.Errorf("%s: %s, want other", file, got)
		}
	}
}

func TestSettingIsOnUnlessItSaysOff(t *testing.T) {
	env := func(value string) func(string) string {
		return func(key string) string {
			if key == "ARCHYMEDES_TEST_FIRST" {
				return value
			}
			return ""
		}
	}
	for _, on := range []string{"", "on", "anything"} {
		if !TestFirstFromEnv(env(on)) {
			t.Errorf("%q should be on", on)
		}
	}
	for _, off := range []string{"off", "OFF", " false ", "0", "no"} {
		if TestFirstFromEnv(env(off)) {
			t.Errorf("%q should be off", off)
		}
	}
}

func TestNothingChangedFinishesAtOnce(t *testing.T) {
	if asked := drain(New(true)); len(asked) != 0 {
		t.Fatalf("asked %q", asked)
	}
}

func TestFullOrderFinishesWithoutAsking(t *testing.T) {
	g := New(true)
	g.Record(write("src/sum.test.ts"))
	g.Record(failedTests)
	g.Record(write("src/sum.ts"))
	g.Record(passed(tool.EvidenceTests))
	g.Record(passed(tool.EvidenceCheck))
	if asked := drain(g); len(asked) != 0 {
		t.Fatalf("asked %q", asked)
	}
	if g.Unverified() {
		t.Fatal("still unverified")
	}
	want := &State{Tests: []string{"src/sum.test.ts"}, Code: []string{"src/sum.ts"}, Red: true, Green: true, Checked: true}
	if got := g.TakeState(); !reflect.DeepEqual(got, want) {
		t.Fatalf("state %+v, want %+v", got, want)
	}
}

func TestCodeAloneAsksEachOnce(t *testing.T) {
	g := New(true)
	g.Record(write("src/sum.ts"))
	asked := drain(g)
	if len(asked) != 3 {
		t.Fatalf("asked %d: %q", len(asked), asked)
	}
	for i, want := range []string{"without writing a test", "without running anything that verifies it", "static analysis"} {
		if !strings.Contains(asked[i], want) {
			t.Errorf("request %d %q, want %q", i, asked[i], want)
		}
	}
	// Each has an honest "no": asked once, never again in the run.
	if next := g.BeforeFinish(); next != "" {
		t.Fatalf("asked again: %q", next)
	}
	if !g.Unverified() {
		t.Fatal("should still be unverified")
	}
}

func TestEditAfterGreenMakesBothStale(t *testing.T) {
	g := New(true)
	g.Record(write("src/a.test.ts"))
	g.Record(write("src/a.ts"))
	g.Record(passed(tool.EvidenceTests))
	g.Record(passed(tool.EvidenceCheck))
	g.Record(write("src/a.ts"))
	state := g.TakeState()
	if state == nil || state.Green || state.Checked {
		t.Fatalf("state %+v, want green and checked false", state)
	}
	g.Record(passed(tool.EvidenceTests))
	expectOne(t, drain(g), "static analysis")
}

func TestRedOnlyAfterTestsAndBeforeCode(t *testing.T) {
	before := New(true)
	before.Record(failedTests) // no test written yet
	before.Record(write("src/a.test.ts"))
	if state := before.TakeState(); state == nil || state.Red {
		t.Fatalf("before: %+v", state)
	}
	after := New(true)
	after.Record(write("src/a.test.ts"))
	after.Record(write("src/a.ts"))
	after.Record(failedTests) // code already changed: a failure, not the test biting
	if state := after.TakeState(); state == nil || state.Red {
		t.Fatalf("after: %+v", state)
	}
}

func TestCodeBeforeTestsNotedOnce(t *testing.T) {
	g := New(true)
	if note := g.Record(write("src/a.ts")); !strings.Contains(note, "Test first") {
		t.Fatalf("note %q", note)
	}
	if note := g.Record(write("src/b.ts")); note != "" {
		t.Fatalf("second note %q", note)
	}
	testsFirst := New(true)
	testsFirst.Record(write("src/a.test.ts"))
	if note := testsFirst.Record(write("src/a.ts")); note != "" {
		t.Fatalf("note after a test %q", note)
	}
}

func TestDocsHeldOnlyToOrdinaryEvidence(t *testing.T) {
	g := New(true)
	if note := g.Record(write("README.md")); note != "" {
		t.Fatalf("note %q", note)
	}
	expectOne(t, drain(g), "without running anything")
	if state := g.TakeState(); state != nil {
		t.Fatalf("state %+v", state)
	}
}

func TestStateReportedOnlyWhenChanged(t *testing.T) {
	g := New(true)
	g.Record(write("src/a.test.ts"))
	if g.TakeState() == nil {
		t.Fatal("first state missing")
	}
	if state := g.TakeState(); state != nil {
		t.Fatalf("unchanged state reported: %+v", state)
	}
	g.Record(passed(tool.EvidenceTests))
	if state := g.TakeState(); state == nil || !state.Green {
		t.Fatalf("state %+v, want green", state)
	}
}

func TestOffAsksOnlyEvidenceThenExecutedTests(t *testing.T) {
	g := New(false)
	if note := g.Record(write("src/a.ts")); note != "" {
		t.Fatalf("note %q", note)
	}
	g.Record(passed(tool.EvidenceCheck))
	expectOne(t, drain(g), "compiles, not that it behaves")
	if state := g.TakeState(); state != nil {
		t.Fatalf("state %+v", state)
	}
}

// Not in the TypeScript tests; pins choices the port had to make explicit.
func TestUnclassifiedEvidenceCountsAsCheckAndOrderIsFirstSeen(t *testing.T) {
	g := New(true)
	g.Record(write("b_test.go"))
	g.Record(write("a_test.go"))
	g.Record(write("b_test.go"))
	g.Record(Record{Effect: tool.EffectNone, Evidence: &tool.Evidence{Passed: true}})
	state := g.TakeState()
	if state == nil || !state.Checked || state.Green || !reflect.DeepEqual(state.Tests, []string{"b_test.go", "a_test.go"}) || state.Code == nil {
		t.Fatalf("state %+v", state)
	}
	expectOne(t, drain(g), "compiles, not that it behaves")
	// A failed evidence record and a write with a blank path change nothing that is tracked.
	h := New(true)
	h.Record(Record{Effect: tool.EffectWorkspace, Args: tool.Args{"path": "  "}})
	if h.TakeState() != nil || !h.Unverified() {
		t.Fatal("blank path should only mark the workspace changed")
	}
	if TestFirstBrief == "" || !strings.HasPrefix(TestFirstBrief, "Build test first.") {
		t.Fatal("brief")
	}
}
