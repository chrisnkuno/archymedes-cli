package advise

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// MinConcern is the least probability, by Jev, for a judged note on an edit to be shown: higher
// than MinUseful, because a note beside every edit that is wrong half the time is noise.
const MinConcern = 0.7

// Note is one thing worth knowing about an edit. A fact is found by code and is so; a judged note
// is Jev's, with its probability in Score.
type Note struct {
	Text  string  `json:"text"`
	Kind  string  `json:"kind"` // fact | judged
	Score float64 `json:"score,omitempty"`
}

// Edit is one change to a file: the text replaced and the text replacing it (edit_file), or no
// Before and the whole new file (write_file). Root is the project, for looking beside the file.
type Edit struct {
	Root, Path    string
	Before, After string
}

var (
	leftBehind = regexp.MustCompile(`\b(TODO|FIXME|XXX|HACK)\b`)
	debugCall  = regexp.MustCompile(`\bconsole\.(log|debug)\(|\bdebugger;|\bdbg!\(|\bvar_dump\(|\bbreakpoint\(\)|\bpdb\.set_trace\(`)
	exported   = []*regexp.Regexp{
		regexp.MustCompile(`^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*[\[(].*`),                                                       // Go
		regexp.MustCompile(`^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+(\w+).*`), // TS, JS
		regexp.MustCompile(`^def\s+([a-z]\w*)\s*\(.*`),                                                                               // Python, top level and public
		regexp.MustCompile(`^\s*pub\s+(?:async\s+)?fn\s+(\w+).*`),                                                                    // Rust
	}
)

// Facts are the notes code can be sure of: something left behind, debug output added, an exported
// signature changed or removed, many lines removed, no test beside the file.
func Facts(e Edit) []Note {
	added, removed := diffLines(e.Before, e.After)
	var notes []Note
	fact := func(format string, args ...any) {
		notes = append(notes, Note{Text: fmt.Sprintf(format, args...), Kind: "fact"})
	}
	if m := firstMatch(leftBehind, added); m != "" {
		fact("Leaves a %s behind", m)
	}
	if m := firstMatch(debugCall, added); m != "" && !IsTest(e.Path) {
		fact("Adds debug output (%s)", strings.TrimSuffix(strings.TrimSuffix(m, "("), ";"))
	}
	if e.Before != "" {
		before, after := signatures(e.Before), signatures(e.After)
		for name, line := range before {
			switch now, ok := after[name]; {
			case !ok && !strings.Contains(e.After, name):
				fact("Removes or renames exported %s; callers may break", name)
			case ok && now != line:
				fact("Changes the signature of exported %s; check its callers", name)
			}
		}
	}
	if n := len(removed) - len(added); n >= 40 {
		fact("Removes %d lines", n)
	}
	if IsCode(e.Path) && !IsTest(e.Path) && e.Root != "" && !testBeside(filepath.Join(e.Root, e.Path)) {
		fact("No test file beside it")
	}
	return notes
}

// diffLines are the trimmed lines only in after (added) and only in before (removed).
func diffLines(before, after string) (added, removed []string) {
	count := map[string]int{}
	for _, l := range strings.Split(before, "\n") {
		count[strings.TrimSpace(l)]++
	}
	for _, l := range strings.Split(after, "\n") {
		t := strings.TrimSpace(l)
		if count[t] > 0 {
			count[t]--
			continue
		}
		if t != "" {
			added = append(added, l)
		}
	}
	for l, n := range count {
		for ; n > 0 && l != ""; n-- {
			removed = append(removed, l)
		}
	}
	return added, removed
}

func firstMatch(re *regexp.Regexp, lines []string) string {
	for _, l := range lines {
		if m := re.FindString(l); m != "" {
			return m
		}
	}
	return ""
}

// signatures are the exported declarations in text, by name, each as its line.
func signatures(text string) map[string]string {
	out := map[string]string{}
	for _, l := range strings.Split(text, "\n") {
		for _, re := range exported {
			if m := re.FindStringSubmatch(l); m != nil {
				out[m[1]] = strings.Join(strings.Fields(m[0]), " ")
			}
		}
	}
	return out
}

// testBeside: a test for file is where the language keeps one (x_test.go, x.test.ts, test_x.py, a
// __tests__ or tests folder beside it).
func testBeside(file string) bool {
	dir, base := filepath.Dir(file), filepath.Base(file)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	candidates := []string{stem + "_test" + ext, stem + ".test" + ext, stem + ".spec" + ext, "test_" + base, stem + "_test.py",
		filepath.Join("__tests__", stem+".test"+ext), filepath.Join("tests", "test_"+base), filepath.Join("..", "tests", "test_"+base)}
	for _, c := range candidates {
		if _, err := os.Stat(filepath.Join(dir, c)); err == nil {
			return true
		}
	}
	if ext == ".go" { // a Go package is tested by any of its _test.go files
		matches, _ := filepath.Glob(filepath.Join(dir, "*_test.go"))
		return len(matches) > 0
	}
	return false
}

// concerns are what Jev is asked about every edit; each is a note when it says yes at MinConcern.
var concerns = []struct {
	name, instructions, yes, no, note string
}{
	{"unhandled", "The new code in `edit.after` ignores an error, a failure or an empty result that it should handle",
		"An error return, rejected promise, exception or empty value is dropped or not checked", "Failures are handled, passed on, or cannot happen here",
		"May leave an error unhandled"},
	{"breaks_callers", "Replacing `edit.before` with `edit.after` changes behaviour that existing callers or users of this code rely on",
		"Callers would see a different result, signature, side effect or default", "The change is internal, additive, or keeps the existing behaviour",
		"May change behaviour that callers rely on"},
}

// Judge is Jev's notes on an edit: one request, a noul per concern. Nothing without a judge or on
// any failure.
func Judge(ctx context.Context, j *Jev, e Edit) []Note {
	if j == nil || !IsCode(e.Path) {
		return nil
	}
	questions := map[string]Question{}
	for _, c := range concerns {
		if c.name == "breaks_callers" && e.Before == "" {
			continue // a whole new file has no earlier behaviour to compare
		}
		questions[c.name] = Question{Type: "noul", Instructions: c.instructions, Criteria: map[string]string{"true": c.yes, "false": c.no}}
	}
	state := map[string]any{"edit": map[string]any{"path": e.Path, "before": clip(e.Before, MaxState/2-200), "after": clip(e.After, MaxState/2-200)}}
	answers, err := j.Ask(ctx, JudgeTimeout, state, questions)
	if err != nil {
		return nil
	}
	var notes []Note
	for _, c := range concerns {
		if a, ok := answers[c.name]; ok && a.Noul >= MinConcern {
			notes = append(notes, Note{Text: c.note, Kind: "judged", Score: a.Noul})
		}
	}
	return notes
}
