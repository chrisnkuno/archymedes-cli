package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/conform"
)

func fixture(t *testing.T, name string, into any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatal(err)
	}
}

// TestRowsMatchTheTypeScriptList: the list the interface draws is the one the TypeScript agent sent.
func TestRowsMatchTheTypeScriptList(t *testing.T) {
	var want []Row
	fixture(t, "rows.json", &want)
	got := List(t.TempDir(), nil, nil).Rows
	if len(got) != len(want) {
		t.Fatalf("%d rows, want %d", len(got), len(want))
	}
	for i := range want {
		if !reflect.DeepEqual(got[i], want[i]) {
			g, _ := json.Marshal(got[i])
			w, _ := json.Marshal(want[i])
			t.Errorf("row %d:\n got %s\nwant %s", i, g, w)
		}
	}
}

// TestValidationMatchesTheTypeScriptRules: every branch of validateSetting, answered alike.
func TestValidationMatchesTheTypeScriptRules(t *testing.T) {
	var cases []struct{ Key, Input, Value, Error string }
	fixture(t, "validate.json", &cases)
	if len(cases) < 1000 {
		t.Fatalf("only %d cases", len(cases))
	}
	for _, c := range cases {
		value, refusal := Validate(c.Key, c.Input)
		if value != c.Value || refusal != c.Error {
			t.Errorf("%s=%q: got (%q, %q), want (%q, %q)", c.Key, c.Input, value, refusal, c.Value, c.Error)
		}
	}
}

func TestSetSavesClearsAndMasks(t *testing.T) {
	dir := t.TempDir()
	if r := Set(dir, "GROQ_API_KEY", "  gsk_abcdefghijkl "); !r.OK || r.Value != "gsk…jkl" || !r.IsSet {
		t.Fatalf("set secret: %+v", r)
	}
	if r := Set(dir, "ARCHYMEDES_SIMPLE", "ON"); !r.OK || r.Value != "on" {
		t.Fatalf("set enum: %+v", r)
	}
	if r := Set(dir, "ARCHYMEDES_SIMPLE", "maybe"); r.OK || r.Error != "Choose one of: on, off." {
		t.Fatalf("refused: %+v", r)
	}
	if r := Set(dir, "NOPE", "x"); r.OK || r.Error != "No setting named NOPE." {
		t.Fatalf("unknown: %+v", r)
	}
	got := Load(dir)
	if got["GROQ_API_KEY"] != "gsk_abcdefghijkl" || got["ARCHYMEDES_SIMPLE"] != "on" {
		t.Fatalf("stored %v", got)
	}
	if r := Set(dir, "ARCHYMEDES_SIMPLE", " "); !r.OK || r.IsSet {
		t.Fatalf("clear: %+v", r)
	}
	if _, ok := Load(dir)["ARCHYMEDES_SIMPLE"]; ok {
		t.Fatal("a cleared setting stayed")
	}
	info, err := os.Stat(File(dir))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v, %v", info.Mode().Perm(), err)
	}
}

func TestSaveKeepsInternalKeysAndDropsUnknownOnes(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(File(dir), []byte(`{"ARCHYMEDES_FREE_PRIVACY_ACK":"yes","SOMETHING_ELSE":"x","GROQ_MODEL":7}`), 0o600)
	Set(dir, "GROQ_MODEL", "llama")
	data, _ := os.ReadFile(File(dir))
	if s := string(data); !strings.Contains(s, `"ARCHYMEDES_FREE_PRIVACY_ACK": "yes"`) || strings.Contains(s, "SOMETHING_ELSE") || !strings.Contains(s, `"GROQ_MODEL": "llama"`) {
		t.Fatalf("saved %s", s)
	}
}

func TestListShowsStoredValuesAndTheEnvironmentWinning(t *testing.T) {
	dir := t.TempDir()
	Set(dir, "OPENROUTER_API_KEY", "sk-or-1234567890")
	Set(dir, "GROQ_MODEL", "llama")
	rows := List(dir, []string{"GROQ_MODEL=mixtral"}, []Choice{{"dark", "dark"}}).Rows
	byKey := map[string]Row{}
	for _, r := range rows {
		byKey[r.Key] = r
	}
	if r := byKey["OPENROUTER_API_KEY"]; r.Value != "sk-…890" || !r.IsSet || r.Kind != "secret" {
		t.Errorf("secret row %+v", r)
	}
	if r := byKey["GROQ_MODEL"]; r.Value != "llama" || !r.OverriddenByEnvironment {
		t.Errorf("overridden row %+v", r)
	}
	if r := byKey["ARCHYMEDES_THEME"]; r.Kind != "choice" || len(r.Choices) != 1 {
		t.Errorf("theme row %+v", r)
	}
}

// TestConformSettingsDocumented: every row of the Settings list is in the configuration reference,
// with its section and its words, and the reference names no setting the list lacks.
func TestConformSettingsDocumented(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "engine", "CONFIGURATION.md"))
	if err != nil {
		t.Fatal(err)
	}
	doc := string(data)
	start := strings.Index(doc, "## The Settings list")
	if start < 0 {
		t.Fatal("CONFIGURATION.md has no section \"The Settings list\"")
	}
	table := doc[start:]
	if end := strings.Index(table[3:], "\n## "); end >= 0 {
		table = table[:end+3]
	}
	documented := map[string]bool{}
	for _, line := range strings.Split(table, "\n") {
		if strings.HasPrefix(line, "| `") {
			documented[strings.Trim(strings.SplitN(line, "|", 3)[1], " `")] = true
		}
	}
	for _, f := range Fields {
		row := "| `" + f.Key + "` | " + SectionOf(f.Key) + " | " + f.Label + " |"
		if !strings.Contains(table, row) {
			t.Errorf("CONFIGURATION.md lacks the row %s", row)
		}
		delete(documented, f.Key)
	}
	for key := range documented {
		t.Errorf("CONFIGURATION.md lists %s, which is not in the Settings list", key)
	}
}

// TestConformSettingsLabels: rows and choices read like help lines.
func TestConformSettingsLabels(t *testing.T) {
	for _, f := range Fields {
		for _, p := range conform.Help(f.Label) {
			t.Errorf("%s: %s", f.Key, p)
		}
		for _, c := range f.Choices {
			for _, p := range conform.Help(c.Label) {
				t.Errorf("%s choice %s: %s", f.Key, c.Value, p)
			}
		}
	}
	for _, c := range append(append(append(languageChoices(), countryChoices()...), currencyChoices()...), providerChoices()...) {
		for _, p := range conform.Help(c.Label) {
			t.Errorf("choice %s: %s", c.Value, p)
		}
	}
}

// TestConcurrentSetsKeepEveryValue: requests are answered at once; no save may undo another.
func TestConcurrentSetsKeepEveryValue(t *testing.T) {
	dir := t.TempDir()
	keys := []string{"ANTHROPIC_MODEL", "OPENAI_MODEL", "GOOGLE_MODEL", "XAI_MODEL", "DEEPSEEK_MODEL", "MISTRAL_MODEL", "GROQ_MODEL", "OLLAMA_MODEL"}
	var wg sync.WaitGroup
	for _, key := range keys {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r := Set(dir, key, "m-"+key); !r.OK {
				t.Errorf("%s: %+v", key, r)
			}
		}()
	}
	wg.Wait()
	got := Load(dir)
	for _, key := range keys {
		if got[key] != "m-"+key {
			t.Errorf("%s lost: %v", key, got)
		}
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "*.tmp")); len(left) > 0 {
		t.Errorf("temporary files left: %v", left)
	}
}

// TestABrokenFileIsNeverReplaced: a hand edit that broke the JSON must not cost every key in it.
func TestABrokenFileIsNeverReplaced(t *testing.T) {
	dir := t.TempDir()
	broken := `{"GROQ_API_KEY": "gsk_keep_me",}`
	os.WriteFile(File(dir), []byte(broken), 0o600)
	r := Set(dir, "ARCHYMEDES_SIMPLE", "on")
	if r.OK || !strings.Contains(r.Error, "Fix or remove it") {
		t.Fatalf("set over a broken file: %+v", r)
	}
	if data, _ := os.ReadFile(File(dir)); string(data) != broken {
		t.Fatalf("the broken file was replaced with %s", data)
	}
}

func TestNumbersAndURLsReadAsTheTypeScriptRulesDid(t *testing.T) {
	for _, c := range []struct {
		key, input, value string
		ok                bool
	}{
		{"ARCHYMEDES_CLOUD_MAXIMUM_MICROS", "0x10", "0x10", true},
		{"ARCHYMEDES_CLOUD_MAXIMUM_MICROS", "0b101", "0b101", true},
		{"ARCHYMEDES_LOW_BALANCE", "1.", "1.", true},
		{"ARCHYMEDES_LOW_BALANCE", ".5e1", ".5e1", true},
		{"ARCHYMEDES_LOW_BALANCE", "0x1p4", "", false},
		{"ARCHYMEDES_LOW_BALANCE", "1_000", "", false},
		{"ARCHYMEDES_LOW_BALANCE", "Infinity", "", false},
		{"VOICE_TRANSCRIPTION_URL", "https://host/my path", "https://host/my%20path", true},
		{"OLLAMA_BASE_URL", "http://[::1]:11434/v1/", "http://[::1]:11434/v1", true},
	} {
		value, refusal := Validate(c.key, c.input)
		if (refusal == "") != c.ok || value != c.value {
			t.Errorf("%s=%q: got (%q, %q)", c.key, c.input, value, refusal)
		}
	}
}
