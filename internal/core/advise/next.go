package advise

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"slices"
	"sort"
	"strings"
	"time"
)

const (
	// MaxSteps is how many next steps a turn ends with.
	MaxSteps = 3
	// MaxProposed is how many the small model may add (the TypeScript engine's maxModel).
	MaxProposed = 2
	// MinUseful is the least probability, by Jev, that a step is worth doing now for it to be shown.
	MinUseful = 0.5
	// JudgeTimeout bounds one Jev request after a turn or an edit.
	JudgeTimeout = 8 * time.Second
)

// Step is one suggested next request: Text is what would be sent (a request or a /command), Why
// says what about the turn makes it worth doing now. Score is Jev's probability that it is, 0 when
// nothing judged it; Source is where it came from, rule or model.
type Step struct {
	Text   string  `json:"text"`
	Why    string  `json:"why"`
	Score  float64 `json:"score,omitempty"`
	Source string  `json:"source"`
}

// Command is one command a turn ran, and how it exited.
type Command struct {
	Text     string `json:"command"`
	Exit     int    `json:"exit"`
	Verifies bool   `json:"verifies,omitempty"` // a test, build or check, not a read
}

// Turn is what a turn did, as facts: the request, the agent's last words, how it ended, the files
// it changed in order, and the commands it ran.
type Turn struct {
	Request  string    `json:"request"`
	Reply    string    `json:"reply"`
	Status   string    `json:"status"`
	Edited   []string  `json:"edited"`
	Commands []Command `json:"commands"`
}

// Verified: a test or check passed after the last edit.
func (t Turn) Verified() bool {
	for i := len(t.Commands) - 1; i >= 0; i-- {
		if t.Commands[i].Verifies {
			return t.Commands[i].Exit == 0
		}
	}
	return false
}

// failing is the last verifying command that failed and was not run again with success.
func (t Turn) failing() (Command, bool) {
	for i := len(t.Commands) - 1; i >= 0; i-- {
		c := t.Commands[i]
		if !c.Verifies {
			continue
		}
		return c, c.Exit != 0
	}
	return Command{}, false
}

// Rules are the next steps what the turn did calls for, most pressing first. Free and instant:
// no model and no judge.
func Rules(t Turn) []Step {
	var steps []Step
	add := func(text, why string) { steps = append(steps, Step{Text: text, Why: why, Source: "rule"}) }
	if t.Status == "stuck" || t.Status == "budget_exhausted" {
		add("Carry on from where you stopped", "the turn ended before the work was done")
	}
	if c, ok := t.failing(); ok {
		add(fmt.Sprintf("Fix what makes `%s` fail", clip(c.Text, 80)), fmt.Sprintf("it exited %d", c.Exit))
	}
	code := slices.DeleteFunc(slices.Clone(t.Edited), func(p string) bool { return !IsCode(p) || IsTest(p) })
	if len(code) > 0 && !t.Verified() {
		if _, failing := t.failing(); !failing {
			add("Run the tests that cover "+names(code), "the change has not been checked yet")
		}
	}
	if len(code) > 0 && !slices.ContainsFunc(t.Edited, IsTest) {
		add("Add a test for the change in "+path.Base(code[0]), "no test was written or changed")
	}
	if len(t.Edited) > 0 {
		if t.Verified() {
			add("Commit this change with a message that says why", "it is changed and checked")
		}
		add("/review", "read the change before it goes further")
	}
	return steps
}

// names is up to two file names, then a count.
func names(paths []string) string {
	var base []string
	for _, p := range paths {
		base = append(base, path.Base(p))
	}
	if len(base) > 2 {
		return fmt.Sprintf("%s, %s and %d more", base[0], base[1], len(base)-2)
	}
	return strings.Join(base, " and ")
}

// ProposeSystem is the small model's instruction when it is asked for steps of its own (the
// TypeScript engine's SUGGESTION_SYSTEM_PROMPT).
const ProposeSystem = "You suggest what a developer might ask a coding agent to do next, based on what just happened.\n" +
	"Reply with a JSON array and nothing else. At most 2 objects, each {\"ask\": string, \"why\": string}.\n" +
	"\"ask\" is a request addressed to the agent, under 12 words, specific to this project.\n" +
	"\"why\" is under 12 words and says what about the session makes it worth doing now.\n" +
	"Suggest nothing that was already done. If nothing is worth suggesting, reply with []."

// Complete is one tool-less model call: an instruction and a message, the reply's text.
type Complete func(ctx context.Context, system, user string) (string, error)

// Propose asks the model for up to two steps of its own. Nothing on any failure.
func Propose(ctx context.Context, complete Complete, t Turn) []Step {
	if complete == nil {
		return nil
	}
	reply, err := complete(ctx, ProposeSystem, describe(t))
	if err != nil {
		return nil
	}
	return parseProposals(reply)
}

func describe(t Turn) string {
	var b strings.Builder
	fmt.Fprintf(&b, "They asked: %s\n", clip(t.Request, 400))
	if t.Reply != "" {
		fmt.Fprintf(&b, "The agent reported: %s\n", clip(t.Reply, 600))
	}
	fmt.Fprintf(&b, "The turn ended: %s · files changed: %s", t.Status, strings.Join(t.Edited, ", "))
	for _, c := range lastCommands(t.Commands, 5) {
		fmt.Fprintf(&b, "\nran `%s`: exit %d", clip(c.Text, 120), c.Exit)
	}
	return b.String()
}

func lastCommands(c []Command, n int) []Command { return c[max(len(c)-n, 0):] }

func parseProposals(text string) []Step {
	start, end := strings.Index(text, "["), strings.LastIndex(text, "]")
	if start < 0 || end <= start {
		return nil
	}
	var raw []struct{ Ask, Why string }
	if json.Unmarshal([]byte(text[start:end+1]), &raw) != nil {
		return nil
	}
	var steps []Step
	for _, r := range raw {
		ask, why := strings.TrimSpace(r.Ask), strings.TrimSpace(r.Why)
		if ask == "" || why == "" || len(ask) > 160 {
			continue
		}
		steps = append(steps, Step{Text: ask, Why: why, Source: "model"})
		if len(steps) == MaxProposed {
			break
		}
	}
	return steps
}

// Rank keeps the steps worth showing, best first, at most MaxSteps. With a judge, each step is
// one noul (is this a useful next step now?) in one request, and only those at MinUseful or above
// stay; without one, or when it cannot answer, the rules' order stands and the model's follow.
func Rank(ctx context.Context, j *Jev, t Turn, steps []Step) []Step {
	steps = unique(steps)
	if j == nil || len(steps) == 0 {
		return steps[:min(len(steps), MaxSteps)]
	}
	questions := map[string]Question{}
	for i, s := range steps {
		questions[fmt.Sprintf("s%d", i)] = Question{Type: "noul",
			Instructions: fmt.Sprintf("Given what the coding agent's turn in `turn` did, asking the agent next for this would be a useful step for the developer now: %q", s.Text),
			Criteria: map[string]string{
				"true":  "It moves the developer's work forward and has not already been done in this turn",
				"false": "It is already done, beside the point of the work, or premature",
			}}
	}
	state := map[string]any{"turn": map[string]any{"request": clip(t.Request, 600), "reply": clip(t.Reply, 1200), "status": t.Status,
		"edited": t.Edited, "commands": lastCommands(t.Commands, 8), "verified": t.Verified()}}
	answers, err := j.Ask(ctx, JudgeTimeout, state, questions)
	if err != nil {
		return steps[:min(len(steps), MaxSteps)]
	}
	var kept []Step
	for i, s := range steps {
		s.Score = answers[fmt.Sprintf("s%d", i)].Noul
		if s.Score >= MinUseful {
			kept = append(kept, s)
		}
	}
	sort.SliceStable(kept, func(a, b int) bool { return kept[a].Score > kept[b].Score })
	return kept[:min(len(kept), MaxSteps)]
}

func unique(steps []Step) []Step {
	seen := map[string]bool{}
	var out []Step
	for _, s := range steps {
		key := strings.ToLower(strings.TrimSpace(s.Text))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, s)
	}
	return out
}

// codeExt are the file extensions counted as code: a change to one wants a test and a check.
var codeExt = map[string]bool{".go": true, ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true, ".py": true,
	".rs": true, ".java": true, ".kt": true, ".rb": true, ".php": true, ".c": true, ".h": true, ".cc": true, ".cpp": true, ".hpp": true,
	".cs": true, ".swift": true, ".scala": true, ".ex": true, ".exs": true, ".dart": true, ".lua": true, ".vue": true, ".svelte": true}

// IsCode: the file is source code, not docs, data or configuration.
func IsCode(p string) bool { return codeExt[strings.ToLower(path.Ext(p))] }

// IsTest: the file is a test, by the conventions of the common languages.
func IsTest(p string) bool {
	p = strings.ToLower(p)
	base := path.Base(p)
	return strings.Contains(base, "_test.") || strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") ||
		strings.HasPrefix(base, "test_") || strings.Contains(p, "/tests/") || strings.Contains(p, "/__tests__/") ||
		strings.HasPrefix(p, "tests/") || strings.HasPrefix(p, "test/") || strings.Contains(p, "/test/")
}
