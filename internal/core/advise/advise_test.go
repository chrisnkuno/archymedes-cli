package advise

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeJev answers every question with answer(name, question); it records the requests it saw.
func fakeJev(t *testing.T, answer func(name string, q Question) Answer) (*Jev, *[]map[string]any) {
	t.Helper()
	var seen []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var req struct {
			Model     string              `json:"model"`
			State     any                 `json:"state"`
			Questions map[string]Question `json:"questions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		seen = append(seen, map[string]any{"model": req.Model, "state": req.State, "questions": req.Questions})
		answers := map[string]Answer{}
		for name, q := range req.Questions {
			answers[name] = answer(name, q)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": req.Model, "answers": answers})
	}))
	t.Cleanup(srv.Close)
	j := NewJev(func(k string) string { return map[string]string{"TYPESAFE_API_KEY": "sk-test"}[k] })
	j.url = srv.URL
	return j, &seen
}

func TestNoKeyOrOffMeansNoJudge(t *testing.T) {
	if NewJev(func(string) string { return "" }) != nil {
		t.Fatal("a judge without a key")
	}
	off := map[string]string{"TYPESAFE_API_KEY": "sk", "ARCHYMEDES_JEV": "off"}
	if NewJev(func(k string) string { return off[k] }) != nil {
		t.Fatal("ARCHYMEDES_JEV=off still made a judge")
	}
	j := NewJev(func(k string) string {
		return map[string]string{"TYPESAFE_API_KEY": "sk", "TYPESAFE_MODEL": "jev-preview"}[k]
	})
	if j == nil || j.model != "jev-preview" {
		t.Fatalf("model setting not read: %+v", j)
	}
}

func TestAMalformedAnswerIsAnErrorThatNamesNoKey(t *testing.T) {
	j, _ := fakeJev(t, func(string, Question) Answer { return Answer{Type: "noul", Noul: 1.7} })
	_, err := j.Ask(context.Background(), JudgeTimeout, "x", map[string]Question{"q": {Type: "noul", Instructions: "?"}})
	if err == nil || strings.Contains(err.Error(), "sk-test") {
		t.Fatalf("err = %v", err)
	}
}

func TestRulesFollowWhatTheTurnDid(t *testing.T) {
	texts := func(steps []Step) string {
		var out []string
		for _, s := range steps {
			out = append(out, s.Text)
		}
		return strings.Join(out, " | ")
	}
	edited := Turn{Edited: []string{"internal/auth/session.go"}}
	if got := texts(Rules(edited)); !strings.Contains(got, "Run the tests that cover session.go") ||
		!strings.Contains(got, "Add a test for the change in session.go") || !strings.Contains(got, "/review") {
		t.Fatalf("an unchecked, untested edit: %s", got)
	}
	failing := Turn{Edited: []string{"a.go", "a_test.go"}, Commands: []Command{{Text: "go test ./...", Exit: 1, Verifies: true}}}
	if got := Rules(failing); got[0].Text != "Fix what makes `go test ./...` fail" || strings.Contains(texts(got), "Add a test") {
		t.Fatalf("a failing check comes first, and a test was written: %s", texts(got))
	}
	green := Turn{Edited: []string{"a.go", "a_test.go"}, Commands: []Command{{Text: "go test ./...", Exit: 0, Verifies: true}}}
	if got := texts(Rules(green)); !strings.Contains(got, "Commit") || strings.Contains(got, "Run the tests") {
		t.Fatalf("a checked change: %s", got)
	}
	if got := Rules(Turn{Status: "stuck"}); len(got) == 0 || got[0].Text != "Carry on from where you stopped" {
		t.Fatalf("a stuck turn: %s", texts(got))
	}
	if got := Rules(Turn{Edited: []string{"README.md"}}); strings.Contains(texts(got), "test") {
		t.Fatalf("docs need no test: %s", texts(got))
	}
}

func TestTheModelsProposalsAreReadOrIgnored(t *testing.T) {
	steps := Propose(context.Background(), func(_ context.Context, system, user string) (string, error) {
		if !strings.Contains(system, "JSON array") || !strings.Contains(user, "They asked: fix login") {
			t.Errorf("prompt: %q / %q", system, user)
		}
		return "Sure:\n[{\"ask\":\"Handle expired tokens in refresh\",\"why\":\"refresh still trusts old tokens\"},{\"ask\":\"\"},{\"ask\":\"a\",\"why\":\"b\"},{\"ask\":\"c\",\"why\":\"d\"}]", nil
	}, Turn{Request: "fix login"})
	if len(steps) != 2 || steps[0].Text != "Handle expired tokens in refresh" || steps[0].Source != "model" {
		t.Fatalf("steps = %+v", steps)
	}
	if got := Propose(context.Background(), func(context.Context, string, string) (string, error) { return "no idea", nil }, Turn{}); got != nil {
		t.Fatalf("prose read as steps: %+v", got)
	}
}

func TestJevKeepsTheUsefulStepsBestFirst(t *testing.T) {
	scores := map[string]float64{"s0": 0.55, "s1": 0.2, "s2": 0.9}
	j, seen := fakeJev(t, func(name string, q Question) Answer {
		if q.Type != "noul" {
			t.Errorf("%s asked as %s", name, q.Type)
		}
		return Answer{Type: "noul", Noul: scores[name]}
	})
	steps := []Step{{Text: "Run the tests"}, {Text: "Commit"}, {Text: "Handle expired tokens"}, {Text: "run the tests"}}
	got := Rank(context.Background(), j, Turn{Request: "fix login"}, steps)
	if len(got) != 2 || got[0].Text != "Handle expired tokens" || got[0].Score != 0.9 || got[1].Text != "Run the tests" {
		t.Fatalf("ranked = %+v", got)
	}
	if qs := (*seen)[0]["questions"].(map[string]Question); len(qs) != 3 || !strings.Contains(qs["s2"].Instructions, "Handle expired tokens") {
		t.Fatalf("questions = %+v", qs)
	}
	// Without a judge, or when it fails, the order stands.
	if got := Rank(context.Background(), nil, Turn{}, steps); len(got) != 3 || got[0].Text != "Run the tests" {
		t.Fatalf("unjudged = %+v", got)
	}
	broken, _ := fakeJev(t, func(string, Question) Answer { return Answer{Type: "choice"} })
	if got := Rank(context.Background(), broken, Turn{}, steps); len(got) != 3 {
		t.Fatalf("a failing judge dropped steps: %+v", got)
	}
}

func TestFactsAboutAnEdit(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	notes := func(e Edit) string {
		var out []string
		for _, n := range Facts(e) {
			out = append(out, n.Text)
		}
		return strings.Join(out, " | ")
	}
	e := Edit{Root: root, Path: "pkg/auth.go",
		Before: "func Refresh(token string) error {\n\treturn nil\n}",
		After:  "func Refresh(ctx context.Context, token string) error {\n\t// TODO: expiry\n\tconsole.log(token)\n\treturn nil\n}"}
	got := notes(e)
	for _, want := range []string{"Leaves a TODO behind", "Adds debug output (console.log)", "Changes the signature of exported Refresh", "No test file beside it"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "pkg", "other_test.go"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := notes(e); strings.Contains(got, "No test file") {
		t.Errorf("a Go package with tests: %s", got)
	}
	removed := Edit{Root: root, Path: "pkg/auth.go", Before: "export function login() {}\nexport const x = 1", After: "export const x = 1"}
	if got := notes(removed); !strings.Contains(got, "Removes or renames exported login") {
		t.Errorf("removed export: %s", got)
	}
	if got := notes(Edit{Root: root, Path: "docs/guide.md", After: "TODO later"}); got != "Leaves a TODO behind" {
		t.Errorf("a doc: %s", got)
	}
}

func TestJevNotesOnlyWhatItIsSureOf(t *testing.T) {
	j, seen := fakeJev(t, func(name string, _ Question) Answer {
		return Answer{Type: "noul", Noul: map[string]float64{"unhandled": 0.82, "breaks_callers": 0.4}[name]}
	})
	got := Judge(context.Background(), j, Edit{Path: "a.go", Before: "x", After: "_ = f()"})
	if len(got) != 1 || got[0].Text != "May leave an error unhandled" || got[0].Kind != "judged" || got[0].Score != 0.82 {
		t.Fatalf("notes = %+v", got)
	}
	Judge(context.Background(), j, Edit{Path: "new.go", After: "package x"})
	if qs := (*seen)[1]["questions"].(map[string]Question); len(qs) != 1 {
		t.Fatalf("a new file was asked about earlier behaviour: %+v", qs)
	}
	if Judge(context.Background(), j, Edit{Path: "notes.md", After: "x"}) != nil || Judge(context.Background(), nil, Edit{Path: "a.go"}) != nil {
		t.Fatal("judged a doc, or without a judge")
	}
}

func TestPickWeighsTheOptionsAgainstWhatIsTyped(t *testing.T) {
	j, seen := fakeJev(t, func(_ string, q Question) Answer {
		return Answer{Type: "choice", Choice: "o1", Confidence: 0.7, Probabilities: map[string]float64{"o0": 0.1, "o1": 0.7, "none": 0.2}}
	})
	scores, none, err := Pick(context.Background(), j, "look over my changes", []string{"/model", "/review"})
	if err != nil || scores[1] != 0.7 || none != 0.2 {
		t.Fatalf("scores=%v none=%v err=%v", scores, none, err)
	}
	q := (*seen)[0]["questions"].(map[string]Question)["intent"]
	if crit := q.Criteria.(map[string]any); crit["o1"] != "/review" || crit["none"] == nil {
		t.Fatalf("criteria = %+v", q.Criteria)
	}
	if _, _, err := Pick(context.Background(), nil, "x", []string{"a"}); err == nil {
		t.Fatal("picked without a judge")
	}
}
