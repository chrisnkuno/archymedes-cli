package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/settings"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

// TestSettingsSetReadsTheKeyWhateverTheValue: a value that is not text clears the setting, as the
// TypeScript agent did, instead of losing the key and answering about a setting named "(none)".
func TestSettingsSetReadsTheKeyWhateverTheValue(t *testing.T) {
	dir := t.TempDir()
	s := New(nil, Options{ConfigDir: dir})
	if r := s.settingsSet(json.RawMessage(`{"key":"ARCHYMEDES_LOW_BALANCE","value":"5"}`)); !r.OK || r.Value != "5" {
		t.Fatalf("text value: %+v", r)
	}
	if r := s.settingsSet(json.RawMessage(`{"key":"ARCHYMEDES_LOW_BALANCE","value":5}`)); !r.OK || r.IsSet {
		t.Fatalf("number value: %+v", r)
	}
	if _, ok := settings.Load(dir)["ARCHYMEDES_LOW_BALANCE"]; ok {
		t.Fatal("a value that is not text did not clear the setting")
	}
}

func TestSubagentsListsEachOnesTokensAndTheTotal(t *testing.T) {
	text := threadsText([]thread.Thread{
		{ID: "t-a", Role: "explore", Status: "done", Brief: "find Add", Usage: &thread.Usage{InputTokens: 12000, OutputTokens: 400, CachedInputTokens: 9000}},
		{ID: "t-b", Role: "review", Status: "running", Brief: "check it"},
	})
	for _, want := range []string{"12.4k tok", "—", "Sub-agents used 12,400 tokens: 12,000 in (9,000 from cache), 400 out."} {
		if !strings.Contains(text, want) {
			t.Errorf("lacks %q:\n%s", want, text)
		}
	}
}

func TestCostCountsTheMainConversationAndEachSubagent(t *testing.T) {
	text := costText(thread.Meta{ModelCalls: 3, Usage: &thread.Usage{InputTokens: 30000, CachedInputTokens: 20000, OutputTokens: 1200}},
		[]thread.Thread{{ID: "t-a", Role: "explore", Usage: &thread.Usage{InputTokens: 4000, OutputTokens: 300}}, {ID: "t-b", Role: "review"}})
	for _, want := range []string{
		"Main conversation: 3 model calls · 30,000 tokens in (20,000 from cache) · 1,200 out",
		"t-a (explore): 4,000 tokens in (0 from cache) · 300 out",
		"Total: 35,500 tokens",
		"Prices are not shown",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "t-b") {
		t.Errorf("a sub-agent that used nothing is listed:\n%s", text)
	}
}

func TestPromptImagesBecomeFileParts(t *testing.T) {
	blocks := []json.RawMessage{
		json.RawMessage(`{"type":"text","text":"what is this"}`),
		json.RawMessage(`{"type":"image","mimeType":"image/png","data":"iVBORw0K","uri":"file:///tmp/shot.png"}`),
	}
	files, err := promptImages(blocks)
	if err != nil || len(files) != 1 || files[0].MediaType != "image/png" || files[0].Filename != "shot.png" || len(files[0].Data) == 0 {
		t.Fatalf("files %+v, %v", files, err)
	}
	if _, err := promptImages([]json.RawMessage{json.RawMessage(`{"type":"image","mimeType":"text/html","data":"eA=="}`)}); err == nil {
		t.Fatal("a non-image passed")
	}
	if _, err := promptImages([]json.RawMessage{json.RawMessage(`{"type":"image","mimeType":"image/png","data":"!!"}`)}); err == nil {
		t.Fatal("bad base64 passed")
	}
}

func TestProfileListsSwitchesAndRefusesAnUnknownName(t *testing.T) {
	dir := t.TempDir()
	s := New(nil, Options{ConfigDir: dir})
	if r := profileCommand(s, ""); !strings.Contains(r["text"].(string), "No profiles yet") {
		t.Fatalf("no profiles: %v", r)
	}
	os.MkdirAll(filepath.Join(dir, "profiles"), 0o700)
	os.WriteFile(filepath.Join(dir, "profiles", "work.json"), []byte(`{}`), 0o600)
	if r := profileCommand(s, "work"); r["kind"] != "text" || !strings.Contains(r["text"].(string), "Profile work from the next session") {
		t.Fatalf("switch: %v", r)
	}
	if settings.Load(dir)["ARCHYMEDES_PROFILE"] != "work" {
		t.Fatal("the profile was not saved")
	}
	if r := profileCommand(s, ""); !strings.Contains(r["text"].(string), "● work") {
		t.Fatalf("list: %v", r)
	}
	if r := profileCommand(s, "play"); r["kind"] != "error" || !strings.Contains(r["text"].(string), "No profile named play") {
		t.Fatalf("unknown: %v", r)
	}
	if r := profileCommand(s, "none"); r["kind"] != "text" || settings.Load(dir)["ARCHYMEDES_PROFILE"] != "" {
		t.Fatalf("clear: %v", r)
	}
	env := claudeEnviron([]string{"PATH=/bin"}, llm.Env{"CLAUDE_CONFIG_DIR": "/c/work"})
	if !slices.Contains(env, "CLAUDE_CONFIG_DIR=/c/work") {
		t.Fatalf("claude environ %v", env)
	}
	home, _ := os.UserHomeDir()
	if env := claudeEnviron(nil, llm.Env{"CLAUDE_CONFIG_DIR": "~/.claude-work"}); !slices.Contains(env, "CLAUDE_CONFIG_DIR="+filepath.Join(home, ".claude-work")) {
		t.Fatalf("~ not expanded: %v", env)
	}
}
