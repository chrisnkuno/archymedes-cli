package server

import (
	"encoding/json"
	"strings"
	"testing"

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
