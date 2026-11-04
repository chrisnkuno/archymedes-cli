package server

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/settings"
)

// rememberServer is a server with two providers set up, OpenAI listed first, and no flag choosing
// either, so what the settings remember decides where a session starts.
func rememberServer(t *testing.T, configDir string, opts Options) *Server {
	t.Helper()
	var calls atomic.Int64
	opts.Cwd, opts.ConfigDir = t.TempDir(), configDir
	opts.Environ = append([]string{"OPENAI_API_KEY=k", "GROQ_API_KEY=k", "ARCHYMEDES_TITLES=off"}, opts.Environ...)
	opts.Open = func(_ context.Context, _ llm.Selection, _ llm.Env, id string) (fantasy.LanguageModel, error) {
		return countingModel{id: id, calls: &calls}, nil
	}
	s := New(nil, opts)
	t.Cleanup(func() {
		s.sessMu.Lock()
		defer s.sessMu.Unlock()
		for _, sess := range s.sessions {
			sess.close()
		}
	})
	return s
}

// startsOn opens a session and says the provider and model it is on.
func startsOn(t *testing.T, s *Server) (id, provider, model string) {
	t.Helper()
	got, err := s.newSession(context.Background(), json.RawMessage(`{}`), false)
	if err != nil {
		t.Fatal(err)
	}
	result := got.(map[string]any)
	info := result["_meta"].(map[string]any)["archymedes"].(map[string]any)
	return result["sessionId"].(string), info["provider"].(string), info["model"].(string)
}

func switchTo(t *testing.T, s *Server, id, provider, model string) error {
	t.Helper()
	params, _ := json.Marshal(map[string]string{"sessionId": id, "provider": provider, "model": model})
	_, err := s.setModel(context.Background(), params)
	return err
}

// TestTheModelLastSwitchedToIsWhereTheNextSessionStarts: the model picker's choice outlives the
// session, across providers and within one, and a flag at start still wins.
func TestTheModelLastSwitchedToIsWhereTheNextSessionStarts(t *testing.T) {
	dir := t.TempDir()
	s := rememberServer(t, dir, Options{})
	id, provider, _ := startsOn(t, s)
	if provider != "openai" {
		t.Fatalf("with nothing remembered the first configured provider starts, got %s", provider)
	}

	if err := switchTo(t, s, id, "groq", "qwen-3-32b"); err != nil {
		t.Fatal(err)
	}
	id, provider, model := startsOn(t, s)
	if provider != "groq" || model != "qwen-3-32b" {
		t.Fatalf("after switching to groq qwen-3-32b the next session starts on %s %s", provider, model)
	}

	// Within one provider: only the model changes.
	if err := switchTo(t, s, id, "", "llama-3.1-8b-instant"); err != nil {
		t.Fatal(err)
	}
	if _, provider, model = startsOn(t, rememberServer(t, dir, Options{})); provider != "groq" || model != "llama-3.1-8b-instant" {
		t.Fatalf("a restart forgot the model: %s %s", provider, model)
	}

	// A flag at start is the person's word for that run, over what was remembered.
	if _, provider, _ = startsOn(t, rememberServer(t, dir, Options{Provider: "openai"})); provider != "openai" {
		t.Fatalf("--provider openai started on %s", provider)
	}
}

// TestAFailedSwitchRemembersNothing: a provider without a key is refused, and the settings are
// left as they were.
func TestAFailedSwitchRemembersNothing(t *testing.T) {
	dir := t.TempDir()
	s := rememberServer(t, dir, Options{})
	id, _, _ := startsOn(t, s)
	if err := switchTo(t, s, id, "anthropic", "claude-sonnet-5"); err == nil {
		t.Fatal("anthropic has no key, yet the switch went through")
	}
	if got := settings.Load(dir); len(got) != 0 {
		t.Fatalf("a refused switch saved %v", got)
	}
}

// TestRememberingKeepsTheOtherSettings: the choice is written over the file, never in place of it.
func TestRememberingKeepsTheOtherSettings(t *testing.T) {
	dir := t.TempDir()
	if r := settings.Set(dir, "ARCHYMEDES_THEME", "dusk"); !r.OK {
		t.Fatalf("seed: %s", r.Error)
	}
	s := rememberServer(t, dir, Options{})
	id, _, _ := startsOn(t, s)
	if err := switchTo(t, s, id, "groq", "qwen-3-32b"); err != nil {
		t.Fatal(err)
	}
	got := settings.Load(dir)
	if got["ARCHYMEDES_THEME"] != "dusk" || got["ARCHYMEDES_PROVIDER"] != "groq" || got["GROQ_MODEL"] != "qwen-3-32b" {
		t.Fatalf("settings after the switch: %v", got)
	}
}
