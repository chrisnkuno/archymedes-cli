package llm

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"charm.land/fantasy"
)

func TestEnvironmentWinsOverSettingsFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"GROQ_API_KEY":"file","GROQ_MODEL":"from-file","N":3}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := LoadEnv(dir, []string{"GROQ_API_KEY=shell", "EMPTY="})
	if env.Get("GROQ_API_KEY") != "shell" || env.Get("GROQ_MODEL") != "from-file" || env.Get("N") != "" {
		t.Fatalf("env = %v", env)
	}
}

func TestResolveFollowsTheTypeScriptOrder(t *testing.T) {
	cases := []struct {
		name            string
		env             Env
		provider, model string
		wantProvider    string
		wantModel       string
		wantErr         string
	}{
		{name: "first configured in catalog order", env: Env{"GROQ_API_KEY": "k", "OPENAI_API_KEY": "k"}, wantProvider: "openai", wantModel: "gpt-5.6-terra"},
		{name: "remembered beats order", env: Env{"GROQ_API_KEY": "k", "OPENAI_API_KEY": "k", "ARCHYMEDES_PROVIDER": "groq", "GROQ_MODEL": "openai/gpt-oss-120b"}, wantProvider: "groq", wantModel: "openai/gpt-oss-120b"},
		{name: "remembered without its key falls through", env: Env{"OPENAI_API_KEY": "k", "ARCHYMEDES_PROVIDER": "groq"}, wantProvider: "openai"},
		{name: "explicit model wins", env: Env{"GROQ_API_KEY": "k", "GROQ_MODEL": "a"}, provider: "groq", model: "b", wantProvider: "groq", wantModel: "b"},
		{name: "explicit provider without key names what is missing", env: Env{}, provider: "anthropic", wantErr: "ANTHROPIC_API_KEY"},
		{name: "nothing configured", env: Env{}, wantErr: "no model provider"},
		{name: "free never pays", env: Env{"OPENROUTER_API_KEY": "k"}, provider: "free", model: "anthropic/claude", wantErr: "paid models are not allowed"},
		{name: "free key alone picks paid openrouter, never free", env: Env{"OPENROUTER_API_KEY": "k"}, wantProvider: "openrouter"},
		{name: "cloud is named, not opened", env: Env{"ARCHYMEDES_CLOUD_TOKEN": "t", "ARCHYMEDES_CLOUD_BASE_URL": "u"}, provider: "archymedes-cloud", wantErr: "not available in the Go engine"},
		{name: "unknown provider", env: Env{}, provider: "nope", wantErr: "unknown provider"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sel, err := Resolve(c.env, c.provider, c.model)
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("err = %v, want %q", err, c.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if sel.Provider.ID != c.wantProvider || (c.wantModel != "" && sel.Model != c.wantModel) {
				t.Fatalf("got %s/%s", sel.Provider.ID, sel.Model)
			}
		})
	}
}

func TestSmallModel(t *testing.T) {
	sel, _ := Resolve(Env{"GROQ_API_KEY": "k", "GROQ_SMALL_MODEL": "llama-3.1-8b-instant"}, "groq", "")
	if sel.Small != "llama-3.1-8b-instant" {
		t.Fatalf("small = %q", sel.Small)
	}
	sel, _ = Resolve(Env{"GROQ_API_KEY": "k"}, "groq", "")
	if sel.Small != sel.Model {
		t.Fatal("without a small model the main one does the cheap work")
	}
	sel, _ = Resolve(Env{"OPENROUTER_API_KEY": "k", "ARCHYMEDES_SMALL_MODEL": "openai/gpt-5"}, "free", "")
	if sel.Small != FreeRouter {
		t.Fatalf("a free session's small model must be free, got %q", sel.Small)
	}
}

type named struct {
	fantasy.LanguageModel
	id string
}

func (n named) Model() string { return n.id }

func TestModelsRouteRolesAndStayFree(t *testing.T) {
	opened := map[string]int{}
	open := func(_ context.Context, _ Selection, _ Env, id string) (fantasy.LanguageModel, error) {
		opened[id]++
		return named{id: id}, nil
	}
	sel := Selection{Provider: Provider{ID: "free"}, Model: FreeRouter, Small: "x/y:free"}
	models, err := NewModels(context.Background(), sel, Env{}, open)
	if err != nil {
		t.Fatal(err)
	}
	for choice, want := range map[string]string{"": FreeRouter, "main": FreeRouter, "small": "x/y:free", "paid/model": FreeRouter, "z/w:free": "z/w:free"} {
		_, id, err := models.For(context.Background(), choice)
		if err != nil || id != want {
			t.Fatalf("For(%q) = %q, %v; want %q", choice, id, err, want)
		}
	}
	if opened[FreeRouter] != 1 {
		t.Fatalf("main model opened %d times", opened[FreeRouter])
	}
	if err := models.Switch(context.Background(), "q/r:free"); err != nil || models.Selection().Model != "q/r:free" || models.Selection().Small != "x/y:free" {
		t.Fatalf("switch: %+v %v", models.Selection(), err)
	}
}

func TestAProfileIsLaidOverTheSettings(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"ARCHYMEDES_PROFILE":"work","GROQ_API_KEY":"personal","GROQ_MODEL":"small"}`), 0o600)
	os.MkdirAll(filepath.Join(dir, "profiles"), 0o700)
	os.WriteFile(filepath.Join(dir, "profiles", "work.json"), []byte(`{"GROQ_API_KEY":"work-key","CLAUDE_CONFIG_DIR":"/home/me/.claude-work"}`), 0o600)
	os.WriteFile(filepath.Join(dir, "profiles", "home.json"), []byte(`{"GROQ_API_KEY":"home-key"}`), 0o600)
	env := LoadEnv(dir, nil)
	if env.Get("GROQ_API_KEY") != "work-key" || env.Get("GROQ_MODEL") != "small" || env.Get("CLAUDE_CONFIG_DIR") != "/home/me/.claude-work" {
		t.Fatalf("with the work profile: %v", env)
	}
	if env := LoadEnv(dir, []string{"ARCHYMEDES_PROFILE=home"}); env.Get("GROQ_API_KEY") != "home-key" {
		t.Fatalf("the shell's profile did not win: %v", env)
	}
	if env := LoadEnv(dir, []string{"ARCHYMEDES_PROFILE=../settings"}); env.Get("GROQ_API_KEY") != "personal" {
		t.Fatalf("a profile name with a path was read: %v", env)
	}
	if got := Profiles(dir); len(got) != 2 || got[0] != "home" || got[1] != "work" {
		t.Fatalf("profiles %v", got)
	}
}
