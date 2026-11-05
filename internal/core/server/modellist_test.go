package server

import (
	"encoding/json"
	"os"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"
)

// The model picker's list (WS-50.4), against the TypeScript agent's answers, with Claude and Codex.

func TestTheModelListIsTypeScripts(t *testing.T) {
	var catalog struct {
		FreeCatalog struct {
			OpenRouterBody json.RawMessage `json:"openRouterBody"`
		} `json:"freeCatalog"`
	}
	data, err := os.ReadFile("../llm/testdata/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(data, &catalog)
	for _, c := range loadProvidersFixture(t).List {
		net := &portNet{routes: func(url string) (int, string, bool) {
			switch {
			case strings.HasPrefix(url, "https://openrouter.ai/api/v1/models"):
				return 200, string(catalog.FreeCatalog.OpenRouterBody), true
			case strings.Contains(url, "api.anthropic.com"):
				return 200, `{"data":[{"id":"claude-new-model"},{"id":"claude-sonnet-5"},{"id":"claude-embed-x"}]}`, true
			case strings.Contains(url, "api.groq.com"):
				return 500, `{}`, true
			}
			return 404, `{}`, true
		}}
		s := initialized(portServer(t, nil, environ(c.Env), net))
		got := call(t, s, "_archymedes/models", c.Params)
		choices, _ := got["choices"].([]any)
		unconfigured, _ := got["unconfigured"].([]any)
		errs, _ := got["errors"].([]any)
		if want := asJSON(t, c.Choices); !reflect.DeepEqual(withoutOutside(choices), want) {
			g, _ := json.Marshal(withoutOutside(choices))
			w, _ := json.Marshal(want)
			t.Errorf("%s: choices\n go %s\n ts %s", c.Name, g, w)
		}
		if want := asJSON(t, c.Unconfigured); !reflect.DeepEqual(withoutOutside(unconfigured), want) {
			t.Errorf("%s: unconfigured\n go %v\n ts %v", c.Name, withoutOutside(unconfigured), want)
		}
		if want := asJSON(t, c.Errors); !reflect.DeepEqual(errs, want) && !(len(errs) == 0 && len(c.Errors) == 0) {
			t.Errorf("%s: errors %v, TypeScript %v", c.Name, errs, want)
		}
		asked := slices.Clone(net.asked)
		for i := range asked {
			asked[i], _, _ = strings.Cut(asked[i], "?")
		}
		sort.Strings(asked)
		if !slices.Equal(asked, c.Asked) && !(len(asked) == 0 && len(c.Asked) == 0) {
			t.Errorf("%s: asked %v, TypeScript %v", c.Name, asked, c.Asked)
		}
	}
}

// TestClaudeAndCodexInTheModelList: Claude's models are usable once Claude Code is, between the
// usable models and the locked ones; Codex's, not installed, come last, locked, with what is missing.
func TestClaudeAndCodexInTheModelList(t *testing.T) {
	s := claudeServer(t, "ARCHYMEDES_MODELS_OFFLINE=1", "GROQ_API_KEY=k", "CLAUDE_MODEL=opus")
	got := call(t, s, "_archymedes/models", json.RawMessage(`{}`))
	choices := got["choices"].([]any)
	var order []string
	for _, c := range choices {
		row := c.(map[string]any)
		order = append(order, row["provider"].(string))
		if row["provider"] == "claude" && (row["locked"] != false || row["price"] != "your Claude plan" || row["isDefault"] != (row["model"] == "opus")) {
			t.Errorf("claude choice %v", row)
		}
	}
	joined := strings.Join(order, ",")
	if !regexp.MustCompile(`^groq,ollama,(claude,)+anthropic,.*,free,codex$`).MatchString(joined) {
		t.Fatalf("order %s", joined)
	}
	last := got["unconfigured"].([]any)
	if u := last[len(last)-1].(map[string]any); u["provider"] != "codex" {
		t.Fatalf("unconfigured ends with %v", u)
	}
}
