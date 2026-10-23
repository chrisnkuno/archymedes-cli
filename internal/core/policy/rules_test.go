package policy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const sampleRules = `{"rules": [
  {"prefix": ["git", "push"], "decision": "ask", "reason": "pushes are reviewed", "match": ["git push origin main", ["git", "push"]], "not_match": ["git pull"]},
  {"prefix": ["rm", ["-rf", "-fr"]], "decision": "forbid", "reason": "Use trash-put instead.", "match": ["rm -rf build", "rm -fr x"], "not_match": ["rm build"]},
  {"prefix": ["npm", ["test", "run"]], "decision": "allow", "match": ["npm test", "npm run lint"]}
]}`

func TestCommandRulesLoad(t *testing.T) {
	rules := ParseCommandRules(sampleRules, "rules.json")
	if len(rules.Problems) != 0 || len(rules.Rules) != 3 {
		t.Fatalf("%+v", rules)
	}
}

func TestCommandRulesLeaveOutBadRules(t *testing.T) {
	loaded := ParseCommandRules(`{"rules": [
	  {"prefix": ["git", "push"], "decision": "ask", "match": ["git pull"]},
	  {"prefix": ["ls"], "decision": "allow", "not_match": ["ls -la"]},
	  {"prefix": [], "decision": "allow"},
	  {"prefix": ["x"], "decision": "maybe"},
	  {"prefix": ["make"], "decision": "allow"}
	]}`, "p.json")
	if len(loaded.Rules) != 1 || describePrefix(loaded.Rules[0].Prefix) != "make" {
		t.Errorf("rules %+v", loaded.Rules)
	}
	want := []string{
		`p.json rule 1 (git push): should match "git pull" but does not — left out`,
		`p.json rule 2 (ls): should not match "ls -la" but does — left out`,
		`p.json rule 3: "prefix" must be a non-empty list of words (or lists of alternative words)`,
		`p.json rule 4: "decision" must be allow, ask or forbid`,
	}
	if !slices.Equal(loaded.Problems, want) {
		t.Errorf("problems\n%q\nwant\n%q", loaded.Problems, want)
	}
	if p := ParseCommandRules("{", "bad.json").Problems; len(p) != 1 || !strings.HasPrefix(p[0], "bad.json: not valid JSON") {
		t.Errorf("bad JSON: %q", p)
	}
	if p := ParseCommandRules(`{"rule": []}`, "x.json").Problems; len(p) != 1 || p[0] != `x.json: expected {"rules": [...]}` {
		t.Errorf("shape: %q", p)
	}
}

func TestJudgeCommand(t *testing.T) {
	rules := ParseCommandRules(sampleRules, "rules.json").Rules
	cases := []struct {
		command string
		want    RuleDecision // "" for no verdict
	}{
		{"npm test", RuleAllow},
		{"npm test && git push", RuleAsk},
		{"npm test; rm -rf dist", RuleForbid},
		{"npm test && ls", ""},
		{"CI=1 /usr/bin/npm run build", RuleAllow},
		{"echo 'rm -rf /'", ""},
	}
	for _, c := range cases {
		got := JudgeCommand(rules, c.command)
		if (got == nil && c.want != "") || (got != nil && got.Decision != c.want) {
			t.Errorf("JudgeCommand(%q) = %+v, want %q", c.command, got, c.want)
		}
	}
	if JudgeCommand(nil, "rm -rf /") != nil {
		t.Error("no rules gave a verdict")
	}
}

func TestSplitCompound(t *testing.T) {
	if got := SplitCompound("a && b || c; d | e\nf"); !slices.Equal(got, []string{"a", "b", "c", "d", "e", "f"}) {
		t.Errorf("%q", got)
	}
	if got := SplitCompound(`echo "a && b" ; echo 'c|d'`); !slices.Equal(got, []string{`echo "a && b"`, `echo 'c|d'`}) {
		t.Errorf("%q", got)
	}
	if got := SplitCompound(`echo a\;b; ls`); !slices.Equal(got, []string{`echo a\;b`, "ls"}) {
		t.Errorf("%q", got)
	}
}

func TestForbiddenMessage(t *testing.T) {
	rules := ParseCommandRules(sampleRules, "rules.json").Rules
	verdict := JudgeCommand(rules, "rm -rf build")
	want := "Refused by a command rule (rm {-rf|-fr}, in rules.json): 'rm -rf build' is not run here. Use trash-put instead."
	if got := ForbiddenMessage("rm -rf build", *verdict); got != want {
		t.Errorf("%q", got)
	}
}

func TestLoadCommandRules(t *testing.T) {
	root, config := t.TempDir(), t.TempDir()
	if got := LoadCommandRules(root, config); len(got.Rules) != 0 || len(got.Problems) != 0 {
		t.Errorf("empty: %+v", got)
	}
	if err := os.MkdirAll(filepath.Join(root, ".archymedes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".archymedes", "rules.json"), []byte(`{"rules": [{"prefix": ["make"], "decision": "forbid"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, "rules.json"), []byte(`{"rules": [{"prefix": ["make"], "decision": "allow"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	loaded := LoadCommandRules(root, config)
	if v := JudgeCommand(loaded.Rules, "make"); v == nil || v.Decision != RuleForbid {
		t.Errorf("verdict %+v", v)
	}
}

func TestPrefixWordJSON(t *testing.T) {
	rule := CommandRule{Prefix: []PrefixWord{Word("rm"), OneOf("-rf", "-fr"), OneOf("x")}, Decision: RuleForbid, Source: "s"}
	data, err := json.Marshal(rule)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"prefix":["rm",["-rf","-fr"],["x"]]`) {
		t.Errorf("%s", data)
	}
	var back CommandRule
	if err := json.Unmarshal(data, &back); err != nil || describePrefix(back.Prefix) != "rm {-rf|-fr} {x}" {
		t.Errorf("%+v %v", back, err)
	}
}

func TestConfigDirectory(t *testing.T) {
	env := func(values map[string]string) func(string) string { return func(k string) string { return values[k] } }
	if got := ConfigDirectory(env(map[string]string{"ARCHYMEDES_CONFIG_DIR": "/cfg"}), "linux"); got != "/cfg" {
		t.Errorf("explicit: %s", got)
	}
	if got := ConfigDirectory(env(map[string]string{"XDG_CONFIG_HOME": "/xdg"}), "linux"); got != filepath.Join("/xdg", "archymedes") {
		t.Errorf("xdg: %s", got)
	}
	if got := ConfigDirectory(env(map[string]string{"APPDATA": "/appdata"}), "windows"); got != filepath.Join("/appdata", "Archymedes") {
		t.Errorf("windows: %s", got)
	}
}
