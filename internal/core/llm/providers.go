// Package llm decides which provider and model a Go-engine session talks to, and opens them as
// Fantasy language models.
//
// The choice follows the TypeScript agent's (packages/core/src/providers/agent-matrix.ts and
// provider-specs.ts) so that switching engines never switches models: settings.json in the shared
// config directory, overlaid by the process environment; an explicit provider first, then the one
// a previous session remembered (ARCHYMEDES_PROVIDER), then the first configured one in catalog
// order; the model from the flag, else <PROVIDER>_MODEL, else the provider's default.
package llm

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Kind is how a provider is reached.
type Kind string

const (
	KindAnthropic  Kind = "anthropic"
	KindOpenAI     Kind = "openai"
	KindOpenRouter Kind = "openrouter"
	// KindCompatible is any Chat Completions endpoint, reached by base URL.
	KindCompatible Kind = "openai-compatible"
	// KindClaudeCode is the person's own Claude Code, run as an engine of its own
	// (internal/core/claude): it has no key and no model to open, only a program to drive.
	KindClaudeCode Kind = "claude-code"
	// KindUnsupported is a provider only the TypeScript engine can open yet.
	KindUnsupported Kind = ""
)

// Provider is one provider's identity: what it needs and what it defaults to.
type Provider struct {
	ID           string
	Label        string
	Requires     []string
	DefaultModel string
	Kind         Kind
	// BaseURL is the default endpoint for a compatible provider; <PREFIX>_BASE_URL overrides it.
	BaseURL string
}

// FreeRouter is free mode's default: OpenRouter's router over free models only.
const FreeRouter = "openrouter/free"

// Providers is the catalog in the TypeScript agent's order, which is load-bearing: with nothing
// chosen, the first configured provider in this order is used.
var Providers = []Provider{
	{ID: "anthropic", Label: "Anthropic", Requires: []string{"ANTHROPIC_API_KEY"}, DefaultModel: "claude-sonnet-5", Kind: KindAnthropic},
	{ID: "openai", Label: "OpenAI", Requires: []string{"OPENAI_API_KEY"}, DefaultModel: "gpt-5.6-terra", Kind: KindOpenAI},
	{ID: "archymedes-cloud", Label: "Archymedes Cloud", Requires: []string{"ARCHYMEDES_CLOUD_TOKEN", "ARCHYMEDES_CLOUD_BASE_URL"}, DefaultModel: "auto", Kind: KindUnsupported},
	{ID: "openrouter", Label: "OpenRouter", Requires: []string{"OPENROUTER_API_KEY"}, DefaultModel: "openrouter/auto", Kind: KindOpenRouter},
	{ID: "google", Label: "Google Gemini", Requires: []string{"GOOGLE_API_KEY"}, DefaultModel: "gemini-2.5-pro", Kind: KindCompatible, BaseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"},
	{ID: "xai", Label: "xAI Grok", Requires: []string{"XAI_API_KEY"}, DefaultModel: "grok-4", Kind: KindCompatible, BaseURL: "https://api.x.ai/v1"},
	{ID: "deepseek", Label: "DeepSeek", Requires: []string{"DEEPSEEK_API_KEY"}, DefaultModel: "deepseek-chat", Kind: KindCompatible, BaseURL: "https://api.deepseek.com/v1"},
	{ID: "mistral", Label: "Mistral", Requires: []string{"MISTRAL_API_KEY"}, DefaultModel: "mistral-large-latest", Kind: KindCompatible, BaseURL: "https://api.mistral.ai/v1"},
	{ID: "groq", Label: "Groq", Requires: []string{"GROQ_API_KEY"}, DefaultModel: "llama-3.3-70b-versatile", Kind: KindCompatible, BaseURL: "https://api.groq.com/openai/v1"},
	{ID: "ollama", Label: "Ollama (local)", DefaultModel: "llama3.1", Kind: KindCompatible, BaseURL: "http://localhost:11434/v1"},
	{ID: "openai-compatible", Label: "OpenAI-compatible", Requires: []string{"OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"}, DefaultModel: "gpt-4o-mini", Kind: KindCompatible},
	{ID: "free", Label: "Free models (OpenRouter)", Requires: []string{"OPENROUTER_API_KEY"}, DefaultModel: FreeRouter, Kind: KindOpenRouter},
}

// ClaudeCode is the person's own Claude Code on their Claude plan. It is not in Providers: it needs
// no key, so it is never picked as "the first configured", and the Providers app lists it itself.
// "default" is Claude Code's own choice of model.
var ClaudeCode = Provider{ID: "claude", Label: "Claude (your subscription)", DefaultModel: "default", Kind: KindClaudeCode}

// Lookup finds a provider by id.
func Lookup(id string) (Provider, bool) {
	if strings.EqualFold(id, ClaudeCode.ID) {
		return ClaudeCode, true
	}
	for _, p := range Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// Prefix is the provider's environment prefix: `openai-compatible` → `OPENAI_COMPATIBLE`.
func (p Provider) Prefix() string {
	return strings.ReplaceAll(strings.ToUpper(p.ID), "-", "_")
}

// Env is the settings the engine reads: settings.json under the environment.
type Env map[string]string

// Get is one trimmed value, "" when unset.
func (e Env) Get(key string) string { return strings.TrimSpace(e[key]) }

// LoadEnv reads <configDir>/settings.json (flat keys to strings, as platform/settings.ts writes it)
// and lays environ ("KEY=value" pairs) over it: a variable set in the shell wins, as it does for
// the TypeScript agent. A missing or broken file is no settings.
func LoadEnv(configDir string, environ []string) Env {
	env := Env{}
	if configDir != "" {
		if data, err := os.ReadFile(filepath.Join(configDir, "settings.json")); err == nil {
			var values map[string]any
			if json.Unmarshal(data, &values) == nil {
				for k, v := range values {
					if s, ok := v.(string); ok {
						env[k] = s
					}
				}
			}
		}
	}
	for _, kv := range environ {
		if k, v, ok := strings.Cut(kv, "="); ok && strings.TrimSpace(v) != "" {
			env[k] = v
		}
	}
	return env
}

// Missing is what is still needed before p can run.
func Missing(p Provider, env Env) []string {
	var missing []string
	for _, name := range p.Requires {
		if env.Get(name) == "" {
			missing = append(missing, name)
		}
	}
	return missing
}

// Selection is a provider and the models a session uses on it.
type Selection struct {
	Provider Provider
	Model    string
	// Small is the model for cheap work (titles, compaction, exploration); Model when none is set.
	Small string
}

// Resolve picks the provider and models. provider and model are explicit choices ("" for none).
func Resolve(env Env, provider, model string) (Selection, error) {
	var spec Provider
	switch {
	case provider != "":
		p, ok := Lookup(provider)
		if !ok && strings.EqualFold(provider, "codex") {
			return Selection{}, fmt.Errorf("Codex runs on the TypeScript engine: set Settings → Engine to TypeScript (or ARCHYMEDES_ENGINE=ts) and start a new session")
		}
		if !ok {
			ids := make([]string, len(Providers))
			for i, p := range Providers {
				ids[i] = p.ID
			}
			return Selection{}, fmt.Errorf("unknown provider %q; choose one of: %s", provider, strings.Join(ids, ", "))
		}
		spec = p
	default:
		p, ok := remembered(env)
		if !ok {
			p, ok = firstConfigured(env)
		}
		if !ok {
			return Selection{}, fmt.Errorf("no model provider is configured: set a key in Settings or Providers (for example GROQ_API_KEY or OPENROUTER_API_KEY)")
		}
		spec = p
	}
	if missing := Missing(spec, env); len(missing) > 0 {
		return Selection{}, fmt.Errorf("%s needs %s", spec.Label, strings.Join(missing, " and "))
	}
	if spec.Kind == KindUnsupported {
		return Selection{}, fmt.Errorf("%s is not available in the Go engine yet; set Settings → Engine to TypeScript (or ARCHYMEDES_ENGINE=ts)", spec.Label)
	}
	chosen := firstNonEmpty(model, env.Get(spec.Prefix()+"_MODEL"), spec.DefaultModel)
	if spec.Kind == KindClaudeCode {
		return Selection{Provider: spec, Model: chosen, Small: chosen}, nil // Claude Code picks its own small model
	}
	if spec.ID == "free" && !IsFreeModel(chosen) {
		return Selection{}, fmt.Errorf("free mode accepts %s or publisher/model:free only; paid models are not allowed", FreeRouter)
	}
	small := firstNonEmpty(env.Get(spec.Prefix()+"_SMALL_MODEL"), env.Get("ARCHYMEDES_SMALL_MODEL"), chosen)
	if spec.ID == "free" && !IsFreeModel(small) {
		small = chosen // a paid small model would quietly bill a free session
	}
	return Selection{Provider: spec, Model: chosen, Small: small}, nil
}

// IsFreeModel is free mode's guard: the free router, or an explicit `:free` model.
func IsFreeModel(model string) bool {
	return model == FreeRouter || strings.HasSuffix(model, ":free")
}

// remembered is the provider a previous session chose, if it can still run. A remembered free
// provider is kept even without its key: losing a free key must never auto-select a paid provider.
func remembered(env Env) (Provider, bool) {
	p, ok := Lookup(env.Get("ARCHYMEDES_PROVIDER"))
	if !ok {
		return Provider{}, false
	}
	if p.ID == "free" || len(Missing(p, env)) == 0 {
		return p, true
	}
	return Provider{}, false
}

// firstConfigured is the first provider that needs a key and has it, never free (whose key also
// configures the paid openrouter provider, which comes first).
func firstConfigured(env Env) (Provider, bool) {
	for _, p := range Providers {
		if len(p.Requires) > 0 && p.ID != "free" && len(Missing(p, env)) == 0 {
			return p, true
		}
	}
	return Provider{}, false
}

// Configured lists every provider that could open now, in catalog order, the unsupported ones too.
func Configured(env Env) []Provider {
	var out []Provider
	for _, p := range Providers {
		if len(Missing(p, env)) == 0 && (len(p.Requires) > 0 || slices.Contains([]string{"ollama"}, p.ID)) {
			out = append(out, p)
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
