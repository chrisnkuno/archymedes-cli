package server

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/claude"
	"github.com/chrisnkuno/friday-cli/internal/core/codex"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/settings"
)

// Connecting a provider in one step (WS-50.3, from server/connect.ts): the person fills in what it
// needs, and the engine checks it the way that matters, by asking the provider for its models. A
// refused key is caught before anything is saved; the models that come back are what the person
// picks from next.

// connectTimeout bounds the listing a connect waits for.
const connectTimeout = 8 * time.Second

var refusedStatus = regexp.MustCompile(`\b40[13]\b`)

// connectProvider answers `_archymedes/providers/connect`.
func (s *Server) connectProvider(ctx context.Context, params json.RawMessage) (any, error) {
	var p struct {
		Provider any            `json:"provider"`
		Values   map[string]any `json:"values"`
	}
	_ = json.Unmarshal(params, &p)
	id, _ := p.Provider.(string)
	env := s.env()
	switch {
	case strings.EqualFold(id, claude.Provider):
		r := s.claudeReadiness(ctx, env, true)
		if !r.ready {
			if r.needs == "claude" {
				return failure("Install Claude Code first: " + claude.InstallURL), nil
			}
			return failure("Sign in to Claude first: enter runs `claude auth login`, Claude Code's own sign-in."), nil
		}
		return connected("", claude.Models(), r.note), nil
	case strings.EqualFold(id, codex.Provider):
		r := s.codexReadiness(ctx, env, true)
		if !r.ready {
			if r.needs == "codex" {
				return failure("Install Codex first: " + codex.InstallURL), nil
			}
			return failure("Sign in to Codex first: enter runs `codex login`, Codex's own sign-in."), nil
		}
		return connected("", codex.Models(), ""), nil
	}
	provider, ok := modelProvider(id)
	if !ok {
		return failure(`Unknown provider "` + id + `".`), nil
	}
	fields := providerFields(provider, env)

	// What changes: a value typed sets its field; an empty URL goes back to the default; an empty
	// secret keeps the one saved (the form shows it masked).
	set, clear := map[string]string{}, map[string]bool{}
	for _, f := range fields {
		raw, isText := p.Values[f.Key].(string)
		raw = strings.TrimSpace(raw)
		if !isText || raw == "" {
			if f.Kind == "url" && isText {
				clear[f.Key] = true
			}
			continue
		}
		value, refusal := settings.Validate(f.Key, raw)
		if refusal != "" {
			return map[string]any{"ok": false, "field": f.Key, "error": refusal}, nil
		}
		set[f.Key] = value
	}
	candidate := llm.Env{}
	for k, v := range env {
		candidate[k] = v
	}
	for key := range clear {
		if !s.inEnviron(key) {
			delete(candidate, key)
		}
	}
	for key, value := range set {
		if !s.inEnviron(key) {
			candidate[key] = value
		}
	}
	if missing := llm.Requirements(provider, candidate); len(missing) > 0 {
		return map[string]any{"ok": false, "field": missing[0], "error": provider.Label + " still needs " + strings.Join(missing, " and ") + "."}, nil
	}
	keyField := ""
	for _, f := range fields {
		if f.Kind == "secret" {
			keyField = f.Key
			break
		}
	}
	refusedKey := func(text string) map[string]any {
		out := map[string]any{"ok": false, "error": text}
		if keyField != "" {
			out["field"] = keyField
		}
		return out
	}
	note := ""
	if key := candidate.Get("OPENROUTER_API_KEY"); (provider.ID == "free" || provider.ID == "openrouter") && key != "" {
		// OpenRouter lists its models without a key, so the listing proves nothing: ask about the key.
		var refused string
		if refused, note = s.checkKey(ctx, key); refused != "" {
			return refusedKey(refused), nil
		}
	}
	listed := llm.FetchProviderModels(ctx, provider.ID, candidate, s.net(), connectTimeout)
	if len(listed.Models) == 0 && refusedStatus.MatchString(listed.Error) {
		return refusedKey(provider.Label + " refused the key (" + listed.Error + "). Check it and paste it again."), nil
	}
	if len(listed.Models) == 0 && note == "" {
		note = "Could not list " + provider.Label + "'s models (" + firstNonEmpty(listed.Error, "none returned") + "). Saved; check the base URL if this persists."
	}
	file, _, err := settings.Update(s.opts.ConfigDir, func(stored map[string]string) string {
		for key := range clear {
			delete(stored, key)
		}
		for key, value := range set {
			stored[key] = value
		}
		return ""
	})
	if err != nil {
		return failure("Could not save: " + err.Error()), nil
	}
	if len(listed.Models) > 0 {
		llm.RememberModels(s.opts.ConfigDir, provider.ID, listed.Models, time.Now())
	}
	return connected(file, listed.Models, note), nil
}

func connected(file string, models []string, note string) map[string]any {
	if models == nil {
		models = []string{}
	}
	out := map[string]any{"ok": true, "file": file, "models": models}
	if note != "" {
		out["note"] = note
	}
	return out
}

// inEnviron says the process environment sets key, which then wins over settings.json.
func (s *Server) inEnviron(key string) bool {
	for _, kv := range s.opts.Environ {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key && strings.TrimSpace(v) != "" {
			return true
		}
	}
	return false
}

// providerModels answers `_archymedes/providers/models`: the provider's models, asked of it now
// (not the cache), and remembered for the pickers.
func (s *Server) providerModels(ctx context.Context, params json.RawMessage) (any, error) {
	var p struct {
		Provider any `json:"provider"`
	}
	_ = json.Unmarshal(params, &p)
	id, _ := p.Provider.(string)
	switch {
	case strings.EqualFold(id, claude.Provider):
		return map[string]any{"models": claude.Models()}, nil
	case strings.EqualFold(id, codex.Provider):
		return map[string]any{"models": codex.Models()}, nil
	}
	provider, ok := modelProvider(id)
	if !ok {
		return map[string]any{"models": []string{}, "error": `Unknown provider "` + id + `".`}, nil
	}
	listed := llm.FetchProviderModels(ctx, provider.ID, s.env(), s.net(), connectTimeout)
	if len(listed.Models) > 0 {
		llm.RememberModels(s.opts.ConfigDir, provider.ID, listed.Models, time.Now())
	}
	out := map[string]any{"models": listed.Models}
	if listed.Error != "" {
		out["error"] = listed.Error
	}
	return out, nil
}

// rememberProviderModel answers `_archymedes/providers/remember-model`: the model picked for a provider
// (<PREFIX>_MODEL) is where its next session starts. For Claude and Codex, "default" clears it.
func (s *Server) rememberProviderModel(_ context.Context, params json.RawMessage) (any, error) {
	var p struct {
		Provider any `json:"provider"`
		Model    any `json:"model"`
	}
	_ = json.Unmarshal(params, &p)
	id, _ := p.Provider.(string)
	model, _ := p.Model.(string)
	model = strings.TrimSpace(model)
	save := func(key, value string) (any, error) {
		_, _, err := settings.Update(s.opts.ConfigDir, func(stored map[string]string) string {
			if value == "" {
				delete(stored, key)
			} else {
				stored[key] = value
			}
			return ""
		})
		if err != nil {
			return map[string]any{"ok": false, "error": "Could not save: " + err.Error()}, nil
		}
		return map[string]any{"ok": true}, nil
	}
	if id == claude.Provider || id == codex.Provider {
		if model == "default" {
			model = ""
		}
		return save(strings.ToUpper(id)+"_MODEL", model)
	}
	provider, ok := modelProvider(id)
	if !ok || model == "" {
		return map[string]any{"ok": false, "error": "A provider and a model are needed."}, nil
	}
	key := provider.Prefix() + "_MODEL"
	if _, ok := settings.Lookup(key); !ok {
		return map[string]any{"ok": true}, nil // a provider whose model is not a setting is not remembered
	}
	value, refusal := settings.Validate(key, model)
	if refusal != "" {
		return map[string]any{"ok": false, "error": refusal}, nil
	}
	return save(key, value)
}
