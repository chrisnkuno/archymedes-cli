// Package gate is what a run must show before it may call workspace changes done, and, when building
// test first, the order it showed them in. A port of packages/core/src/verification-gate.ts.
//
// The loop asks it at two moments: after every tool result (Record), and when the model says it has
// finished (BeforeFinish). Every request it makes of the model is asked at most once, because each one
// has an honest "no" (nothing to assert, no checker in this project), and a gate that cannot be
// satisfied honestly is a gate that gets worked around.
//
// Test first (on by default while building; ARCHYMEDES_TEST_FIRST=off) is the order Friday works in:
// tests that define done, seen failing; then the code that makes them pass; then light static
// analysis. What the gate can see is which files changed and which commands passed or failed, so that
// is what it holds the run to: a test file written for a code change, tests passing after the last
// code edit, and a static check passing after it too.
package gate

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// EvidenceRank is evidence strength as a ladder; see tool.EvidenceKind for each rung.
var EvidenceRank = map[tool.EvidenceKind]int{
	tool.EvidenceCheck:    1,
	tool.EvidenceTests:    2,
	tool.EvidenceSmoke:    3,
	tool.EvidenceBehavior: 4,
}

// State is where a test-first run is, for an interface to show.
type State struct {
	// Tests are test files written or edited this run, in first-seen order.
	Tests []string `json:"tests"`
	// Code are code files (not tests) changed this run, in first-seen order.
	Code []string `json:"code"`
	// Red: a test run failed after tests were written and before the code changed.
	Red bool `json:"red"`
	// Green: tests passed since the last code change.
	Green bool `json:"green"`
	// Checked: a static check (typecheck, lint, vet) passed since the last code change.
	Checked bool `json:"checked"`
}

const maxVerificationNudges = 1

const verificationNudge = "You changed the workspace but ended the turn without running anything that verifies it. Run the smallest relevant existing test, check, or smoke command and report the real result. Add a regression test only when the change would otherwise be unprotected. If this project genuinely has nothing relevant to run, say so explicitly instead of stopping silently."

// testEvidenceNudge is sent when the only evidence was a build, typecheck or lint: a passing compile is
// real but says nothing about behaviour.
const testEvidenceNudge = "That build/typecheck passing shows the code compiles, not that it behaves correctly. Run the smallest relevant existing test or smoke command for the changed behaviour and report the real result. Add a regression test only when the change would otherwise be unprotected. If the change genuinely has no behaviour to assert (documentation, formatting, configuration), say so explicitly and stop."

// testsFirstNudge: code changed and no test was written for it.
const testsFirstNudge = "You changed code without writing a test for it, and this project builds test first. Write clean tests for the change now: invariants that hold for every valid input, one behavioural test per requested rule, one functional test of the assembled thing. Run them and make them pass. If existing tests already pin this behaviour, name them and run them; if the change truly has nothing to assert, say why in one line and stop."

// staticAnalysisNudge: tests are green but nothing static has looked at the code.
const staticAnalysisNudge = "Finish with light static analysis: run the project's own typecheck, linter or vet (tsc --noEmit, go vet ./..., ruff check, cargo clippy: whatever it already uses) on what you changed, and fix what it reports in your code. Do not install new tools for this. If the project has none, say so in one line and stop."

// codeBeforeTestsNote is appended once to the result of the first code edit that came before any test.
const codeBeforeTestsNote = "[Test first: this changed code before any test was written in this turn. Next, write the tests that define this change (or run the existing ones that cover it) and see them fail for the right reason, then continue with the code.]"

var codeExtensions = regexp.MustCompile(`(?i)\.(?:[cm]?[jt]sx?|go|py|rs|java|kt|kts|scala|rb|php|cs|swift|c|cc|cpp|cxx|h|hpp|m|mm|dart|ex|exs|erl|clj|hs|ml|lua|r|jl|zig|nim|vue|svelte|sh)$`)

var testPath = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(?:^|/)(?:tests?|__tests__|specs?|testing|e2e)/`),
	regexp.MustCompile(`(?i)\.(?:test|spec|e2e)\.[a-z]+$`),
	regexp.MustCompile(`(?i)_test\.[a-z]+$`),
	regexp.MustCompile(`(?i)(?:^|/)test_[^/]+\.py$`),
	regexp.MustCompile(`(?i)_spec\.rb$`),
	regexp.MustCompile(`Tests?\.(?:java|kt|cs|swift|scala)$`),
}

// ClassifyPath says whether a path is a test file, a code file, or anything else (docs, config,
// styles), by the path alone: "test", "code" or "other".
func ClassifyPath(path string) string {
	normalized := strings.ReplaceAll(path, `\`, "/")
	for _, pattern := range testPath {
		if pattern.MatchString(normalized) {
			return "test"
		}
	}
	if codeExtensions.MatchString(normalized) {
		return "code"
	}
	return "other"
}

var offSetting = regexp.MustCompile(`(?i)^(?:off|false|0|no)$`)

// TestFirstFromEnv reads ARCHYMEDES_TEST_FIRST: on unless it says off.
func TestFirstFromEnv(getenv func(string) string) bool {
	return !offSetting.MatchString(strings.TrimSpace(getenv("ARCHYMEDES_TEST_FIRST")))
}

// TestFirstBrief is the same order of work, for an engine that keeps its own prompt and loop (Claude
// Code): appended to its instructions, since no gate of ours runs inside it.
const TestFirstBrief = "Build test first. For every code change: (1) before the code, write clean tests that define done in the project's own runner: invariants over edge inputs, one behavioural test per requested rule, one functional test of the assembled thing; run them and see them fail for the right reason (a bug fix starts with the test that reproduces it)." +
	" (2) Write the smallest code that makes them pass; never weaken, skip or delete a test to get green. (3) Finish with light static analysis: the project's own typecheck, linter or vet on what you changed, fixing what it reports; install nothing for it." +
	" Report the tests written, that they failed then passed, and the check's result. Docs, configuration and changes with nothing to assert skip the tests and the check: say so in one line."

// Record is one tool result, as the gate needs it.
type Record struct {
	ToolName string
	Args     tool.Args
	Effect   tool.Effect
	IsError  bool
	Evidence *tool.Evidence
	// Data is the tool's data: a failed run's "verificationKind" says a test run failed, which no
	// Evidence records.
	Data map[string]any
}

// Gate holds one run to its evidence. It is not safe for concurrent use; the loop calls it from one
// goroutine.
type Gate struct {
	testFirst              bool
	needsVerification      bool
	verificationNudges     int
	strongestEvidence      int
	askedForTestEvidence   bool
	askedForTests          bool
	askedForStaticAnalysis bool
	notedCodeBeforeTests   bool
	tests                  orderedSet
	code                   orderedSet
	red, green, checked    bool
	lastShown              string
}

// New is a gate for one run; testFirst turns on the test-first order.
func New(testFirst bool) *Gate { return &Gate{testFirst: testFirst} }

// Unverified reports workspace changes not yet followed by passing evidence.
func (g *Gate) Unverified() bool { return g.needsVerification }

// Record folds in one tool result. It returns a note for the model to read with that result, or "".
func (g *Gate) Record(r Record) string {
	if r.IsError {
		// A failing test run after tests were written and before any code changed: red, as intended.
		kind, _ := r.Data["verificationKind"].(string)
		if g.tests.len() > 0 && g.code.len() == 0 && (kind == "tests" || kind == "smoke" || kind == "behavior") {
			g.red = true
		}
		return ""
	}
	note := ""
	if r.Effect == tool.EffectWorkspace {
		g.needsVerification = true
		path := pathOf(r.Args)
		kind := "other"
		if path != "" {
			kind = ClassifyPath(path)
		}
		if kind == "test" {
			g.tests.add(path)
		}
		if kind == "code" {
			if g.testFirst && g.tests.len() == 0 && !g.notedCodeBeforeTests {
				g.notedCodeBeforeTests = true
				note = codeBeforeTestsNote
			}
			g.code.add(path)
			g.green = false
			g.checked = false
		}
	}
	if evidence := r.Evidence; evidence != nil && evidence.Passed {
		g.needsVerification = false
		// Unclassified evidence reads as check: the weaker claim is the safe one to infer. Kept as a
		// maximum so a later weak check cannot demote what a stronger run established.
		kind := evidence.Kind
		if kind == "" {
			kind = tool.EvidenceCheck
		}
		rank, known := EvidenceRank[kind]
		if !known {
			rank = EvidenceRank[tool.EvidenceCheck]
		}
		g.strongestEvidence = max(g.strongestEvidence, rank)
		if kind == tool.EvidenceCheck {
			g.checked = true
		} else {
			g.green = true
		}
	}
	return note
}

// BeforeFinish is, at the model's stop, what to ask of it before the run may end, or "" to let it
// end. Test first's own requests only apply when code changed; a docs or config change is held to the
// ordinary evidence rules alone.
func (g *Gate) BeforeFinish() string {
	building := g.testFirst && g.code.len() > 0
	if building && g.tests.len() == 0 && !g.askedForTests {
		g.askedForTests = true
		return testsFirstNudge
	}
	if g.needsVerification && g.verificationNudges < maxVerificationNudges {
		g.verificationNudges++
		return verificationNudge
	}
	// One rung at a time up EvidenceRank: compile-only evidence is accepted in the end, but not before
	// asking once for executed tests.
	if g.strongestEvidence == EvidenceRank[tool.EvidenceCheck] && !g.askedForTestEvidence {
		g.askedForTestEvidence = true
		return testEvidenceNudge
	}
	if building && !g.checked && !g.askedForStaticAnalysis {
		g.askedForStaticAnalysis = true
		return staticAnalysisNudge
	}
	return ""
}

// TakeState is where a test-first run is, when that changed since the last call; nil otherwise or
// when test first is off.
func (g *Gate) TakeState() *State {
	if !g.testFirst || (g.tests.len() == 0 && g.code.len() == 0) {
		return nil
	}
	state := &State{Tests: g.tests.values(), Code: g.code.values(), Red: g.red, Green: g.green, Checked: g.checked}
	encoded, _ := json.Marshal(state)
	if string(encoded) == g.lastShown {
		return nil
	}
	g.lastShown = string(encoded)
	return state
}

func pathOf(args tool.Args) string {
	path, _ := args["path"].(string)
	return strings.TrimSpace(path)
}

// orderedSet keeps insertion order, as a JavaScript Set does.
type orderedSet struct {
	order []string
	seen  map[string]bool
}

func (s *orderedSet) add(value string) {
	if s.seen == nil {
		s.seen = map[string]bool{}
	}
	if !s.seen[value] {
		s.seen[value] = true
		s.order = append(s.order, value)
	}
}

func (s *orderedSet) len() int { return len(s.order) }

func (s *orderedSet) values() []string { return append([]string{}, s.order...) }
