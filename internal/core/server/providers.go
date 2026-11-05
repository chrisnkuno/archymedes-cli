package server

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/claude"
	"github.com/chrisnkuno/friday-cli/internal/core/codex"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/settings"
)

// First-run setup and the Providers app (WS-50.3, ported from server/setup.ts, server/connect.ts
// and engines/{claude,codex}/backend.ts): which providers could run, what each is set up with, a
// key checked and saved in one step. Archymedes Cloud is not offered: it is not ported (WS-50).

// keyURLs are where each key-only provider hands out keys.
var keyURLs = map[string]string{
	"free":       "https://openrouter.ai/keys",
	"openrouter": "https://openrouter.ai/keys",
	"anthropic":  "https://console.anthropic.com/settings/keys",
	"openai":     "https://platform.openai.com/api-keys",
	"google":     "https://aistudio.google.com/apikey",
	"xai":        "https://console.x.ai",
	"deepseek":   "https://platform.deepseek.com/api_keys",
	"mistral":    "https://console.mistral.ai/api-keys",
	"groq":       "https://console.groq.com/keys",
}

// defaultBaseURLs are each provider's endpoint when no base URL is set: the field's hint, never saved.
var defaultBaseURLs = map[string]string{
	"anthropic":  "https://api.anthropic.com",
	"openai":     "https://api.openai.com/v1",
	"openrouter": "https://openrouter.ai/api/v1",
	"google":     "https://generativelanguage.googleapis.com/v1beta/openai",
	"xai":        "https://api.x.ai/v1",
	"deepseek":   "https://api.deepseek.com/v1",
	"mistral":    "https://api.mistral.ai/v1",
	"groq":       "https://api.groq.com/openai/v1",
	"ollama":     "http://localhost:11434/v1",
}

// offered are the providers in the order setup shows them: free first, then the catalog's order.
func offered() []llm.Provider {
	var out []llm.Provider
	for _, p := range llm.Providers {
		if p.ID == "free" {
			out = append([]llm.Provider{p}, out...)
		} else if p.ID != "archymedes-cloud" {
			out = append(out, p)
		}
	}
	return out
}

// modelProvider is a provider of the model catalog (not Claude or Codex), by id.
func modelProvider(id string) (llm.Provider, bool) {
	for _, p := range llm.Providers {
		if p.ID == id {
			return p, true
		}
	}
	return llm.Provider{}, false
}

// setupRow is one provider as setup offers it.
type setupRow struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	KeyVariable string `json:"keyVariable,omitempty"`
	KeyURL      string `json:"keyUrl,omitempty"`
	Configured  bool   `json:"configured"`
}

func setupRowFor(p llm.Provider, env llm.Env) setupRow {
	row := setupRow{ID: p.ID, Label: p.Label, KeyURL: keyURLs[p.ID], Configured: len(llm.Requirements(p, env)) == 0}
	if len(p.Requires) == 1 {
		if _, ok := settings.Lookup(p.Requires[0]); ok {
			row.KeyVariable = p.Requires[0]
		}
	}
	return row
}

// field is one value a provider is set up with; a secret's value is masked.
type field struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Kind        string `json:"kind"`
	Required    bool   `json:"required"`
	IsSet       bool   `json:"isSet"`
	Value       string `json:"value"`
	Placeholder string `json:"placeholder,omitempty"`
}

// providerFields are what p is set up with: what it requires, then its base URL when it has one
// (free mode has none: OpenRouter's fixed endpoint or a gateway).
func providerFields(p llm.Provider, env llm.Env) []field {
	keys := append([]string(nil), p.Requires...)
	if base := p.Prefix() + "_BASE_URL"; p.ID != "free" && !contains(keys, base) {
		if _, ok := settings.Lookup(base); ok {
			keys = append(keys, base)
		}
	}
	out := []field{}
	for _, key := range keys {
		spec, ok := settings.Lookup(key)
		if !ok {
			continue
		}
		f := field{Key: key, Label: spec.Label, Kind: "text", Required: contains(p.Requires, key), Value: env.Get(key)}
		f.IsSet = f.Value != ""
		switch {
		case spec.Secret:
			f.Kind = "secret"
			if f.IsSet {
				f.Value = settings.Mask(f.Value)
			}
		case spec.URL:
			f.Kind = "url"
			f.Placeholder = firstNonEmpty(defaultBaseURLs[p.ID], "https://…/v1")
		}
		out = append(out, f)
	}
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// overviewRow is one provider as the Providers app shows it.
type overviewRow struct {
	setupRow
	Missing   []string `json:"missing"`
	Model     string   `json:"model"`
	IsDefault bool     `json:"isDefault"`
	Fields    []field  `json:"fields"`
	Login     []string `json:"login,omitempty"`
	Note      string   `json:"note,omitempty"`
	About     string   `json:"about,omitempty"`
}

// readiness is whether an outside engine (Claude Code, Codex) can run a session now.
type readiness struct {
	ready                 bool
	executable, needs     string
	missing, note         string
	installURL, about     string
	login                 []string
	provider, label, name string
	model                 string
}

var (
	claudeAuthMu    sync.Mutex
	claudeAuthCache struct {
		key  string // the executable and the environment it runs in (a profile can be another account)
		at   time.Time
		auth claude.Auth
	}
)

// claudeReadiness is whether Claude Code is installed and signed in (asked at most every half
// minute; fresh asks now). This engine drives Claude Code itself: Anthropic's Agent SDK, which the
// TypeScript engine needed, is not asked for.
func (s *Server) claudeReadiness(ctx context.Context, env llm.Env, fresh bool) readiness {
	r := readiness{provider: claude.Provider, label: claude.Label, name: "Claude", installURL: claude.InstallURL, model: firstNonEmpty(env.Get("CLAUDE_MODEL"), "default")}
	r.executable = claude.Find(env.Get)
	if r.executable == "" {
		r.needs, r.missing = "claude", "Claude Code installed ("+claude.InstallURL+")"
		return r
	}
	claudeAuthMu.Lock()
	cached := claudeAuthCache
	claudeAuthMu.Unlock()
	auth := cached.auth
	environ := claudeEnviron(s.opts.Environ, env)
	key := r.executable + "\x00" + strings.Join(environ, "\x00")
	if fresh || cached.key != key || time.Since(cached.at) >= 30*time.Second {
		auth, _ = claude.SignedIn(ctx, r.executable, environ)
		claudeAuthMu.Lock()
		claudeAuthCache.key, claudeAuthCache.at, claudeAuthCache.auth = key, time.Now(), auth
		claudeAuthMu.Unlock()
	}
	if !auth.LoggedIn {
		r.needs, r.missing = "sign-in", "signing in to Claude (claude auth login)"
		r.login = []string{r.executable, "auth", "login"}
		return r
	}
	r.ready = true
	switch {
	case auth.SubscriptionType != "":
		r.note = "Signed in with Claude " + strings.ToUpper(auth.SubscriptionType[:1]) + auth.SubscriptionType[1:] + ": turns use your plan's limits."
	case auth.AuthMethod != "" && auth.AuthMethod != "claude.ai":
		r.note = "Claude Code is signed in with an API key (" + auth.AuthMethod + "): turns are billed per token."
	}
	return r
}

// codexReadiness is whether Codex is installed and signed in.
func (s *Server) codexReadiness(ctx context.Context, env llm.Env, fresh bool) readiness {
	c := codex.Check(ctx, env.Get, s.opts.Environ, fresh)
	r := readiness{provider: codex.Provider, label: codex.Label, name: "Codex", installURL: codex.InstallURL, about: codex.About,
		model: firstNonEmpty(env.Get("CODEX_MODEL"), "default"), ready: c.Ready, executable: c.Executable, needs: c.Needs, missing: c.Missing, note: codex.Note(c.Auth)}
	if c.Needs == "sign-in" {
		r.login = append([]string{c.Executable}, codex.LoginArgs...)
	}
	return r
}

func (r readiness) row(env llm.Env) overviewRow {
	row := overviewRow{setupRow: setupRow{ID: r.provider, Label: r.label, Configured: r.ready}, Missing: []string{}, Model: r.model,
		IsDefault: strings.EqualFold(env.Get("ARCHYMEDES_PROVIDER"), r.provider), Fields: []field{}, Login: r.login, Note: r.note, About: r.about}
	if !r.ready {
		row.Missing = []string{r.missing}
		if r.needs == "claude" || r.needs == "codex" {
			row.KeyURL = r.installURL
		}
	}
	return row
}

// providers answers `_archymedes/providers`: every provider, free first, then Claude and Codex.
func (s *Server) providers(ctx context.Context, _ json.RawMessage) (any, error) {
	env := s.env()
	var rows []overviewRow
	for _, p := range offered() {
		rows = append(rows, overviewRow{
			setupRow: setupRowFor(p, env), Missing: llm.Requirements(p, env),
			Model: firstNonEmpty(env.Get(p.Prefix()+"_MODEL"), p.DefaultModel), IsDefault: strings.EqualFold(env.Get("ARCHYMEDES_PROVIDER"), p.ID),
			Fields: providerFields(p, env),
		})
	}
	// After free, which needs nothing at all: Claude, then Codex.
	outside := []overviewRow{s.claudeReadiness(ctx, env, false).row(env), s.codexReadiness(ctx, env, false).row(env)}
	rows = append(rows[:1], append(outside, rows[1:]...)...)
	return map[string]any{"providers": rows}, nil
}

// setupStatus answers `_archymedes/setup/status`: can a session open as things are set up, and
// which providers could be set up with one key. A session on Claude or Codex is ready when that
// engine is installed and signed in.
func (s *Server) setupStatus(ctx context.Context, _ json.RawMessage) (any, error) {
	env := s.env()
	rows := []setupRow{}
	for _, p := range offered() {
		rows = append(rows, setupRowFor(p, env))
	}
	status := map[string]any{"configured": true, "providers": rows}
	_, err := llm.Resolve(env, s.opts.Provider, s.opts.Model)
	wanted := strings.ToLower(firstNonEmpty(s.opts.Provider, env.Get("ARCHYMEDES_PROVIDER")))
	var outside *readiness
	switch wanted {
	case claude.Provider:
		r := s.claudeReadiness(ctx, env, false)
		outside = &r
	case codex.Provider:
		r := s.codexReadiness(ctx, env, false)
		outside = &r
	}
	switch {
	case outside != nil && outside.ready:
	case outside != nil:
		status["configured"], status["reason"] = false, outside.name+" needs "+outside.missing+"."
	case err != nil:
		status["configured"], status["reason"] = false, err.Error()
	}
	return status, nil
}

// net is how listings and key checks reach the providers.
func (s *Server) net() llm.Getter {
	if s.opts.Net != nil {
		return s.opts.Net
	}
	return llm.DefaultGetter
}

// checkKey asks OpenRouter about a key: an error when it refused it, a note when it could not say.
func (s *Server) checkKey(ctx context.Context, key string) (refused, note string) {
	check := llm.CheckOpenRouterKey(ctx, s.net(), key)
	switch {
	case check.OK:
		return "", ""
	case check.Reason == "invalid":
		return llm.DescribeKeyCheck(check), ""
	}
	return "", llm.DescribeKeyCheck(check) + " Saved anyway; the first request will confirm it."
}

func failure(text string) map[string]any { return map[string]any{"ok": false, "error": text} }

// setupSave answers `_archymedes/setup/save`: check one key, save it, and make its provider the
// one new sessions start on.
func (s *Server) setupSave(ctx context.Context, params json.RawMessage) (any, error) {
	var p struct {
		Provider any `json:"provider"`
		Key      any `json:"key"`
	}
	_ = json.Unmarshal(params, &p)
	id, _ := p.Provider.(string)
	raw, _ := p.Key.(string)
	raw = strings.TrimSpace(raw)
	provider, ok := modelProvider(id)
	if !ok {
		return failure(`Unknown provider "` + id + `".`), nil
	}
	row := setupRowFor(provider, s.env())
	switch {
	case provider.ID == "archymedes-cloud" || row.KeyVariable == "":
		return failure(provider.Label + " needs more than a key; run friday settings."), nil
	case raw == "":
		return failure("The key is empty."), nil
	}
	key, refusal := settings.Validate(row.KeyVariable, raw)
	if refusal != "" {
		return failure(refusal), nil
	}
	note := ""
	if provider.ID == "free" || provider.ID == "openrouter" {
		var refused string
		if refused, note = s.checkKey(ctx, key); refused != "" {
			return failure(refused), nil
		}
	}
	file, refusal, err := settings.Update(s.opts.ConfigDir, func(stored map[string]string) string {
		stored[row.KeyVariable], stored["ARCHYMEDES_PROVIDER"] = key, provider.ID
		return ""
	})
	if err != nil {
		return failure("Could not save: " + err.Error()), nil
	}
	out := map[string]any{"ok": true, "file": file}
	if note != "" {
		out["note"] = note
	}
	return out, nil
}

// models are the outside engine's models: what a session learned, else its aliases or default.
func (r readiness) models() []string {
	if r.provider == claude.Provider {
		return claude.Models()
	}
	return codex.Models()
}

// price is how the outside engine is paid for: the person's own plan.
func (r readiness) price() string {
	if r.provider == claude.Provider {
		return "your Claude plan"
	}
	return "your ChatGPT plan"
}
