package llm

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"charm.land/fantasy"
	"charm.land/fantasy/providers/openai"
	"charm.land/fantasy/providers/openaicompat"
)

// UserAgent is sent with every request.
var UserAgent = "friday-go-engine"

// Opener opens one model of a provider; tests replace it with a scripted model.
type Opener func(ctx context.Context, sel Selection, env Env, model string) (fantasy.LanguageModel, error)

// OpenModel is the real Opener. Anthropic is reached natively (anthropic.go); everything else
// speaks Chat Completions, through Fantasy's OpenAI provider (OpenAI itself) or its compatible one
// (every other vendor, OpenRouter and free mode included, at their base URLs).
func OpenModel(ctx context.Context, sel Selection, env Env, model string) (fantasy.LanguageModel, error) {
	p := sel.Provider
	key := ""
	if len(p.Requires) > 0 {
		key = env.Get(p.Requires[0])
	}
	base := env.Get(p.Prefix() + "_BASE_URL")
	var (
		provider fantasy.Provider
		err      error
	)
	switch p.Kind {
	case KindAnthropic:
		return newAnthropic(key, base, model), nil
	case KindOpenAI:
		opts := []openai.Option{openai.WithAPIKey(key), openai.WithUserAgent(UserAgent)}
		if base != "" {
			opts = append(opts, openai.WithBaseURL(base))
		}
		provider, err = openai.New(opts...)
	case KindOpenRouter:
		if p.ID == "free" {
			base = env.Get("OPENROUTER_BASE_URL")
		}
		if base == "" {
			base = OpenRouterBase
		}
		provider, err = openaicompat.New(openaicompat.WithBaseURL(base), openaicompat.WithAPIKey(key), openaicompat.WithName(p.ID), openaicompat.WithUserAgent(UserAgent),
			openaicompat.WithHeaders(map[string]string{"HTTP-Referer": "https://archymedes.xyz", "X-Title": "Friday"}))
	case KindCompatible:
		if base == "" {
			base = p.BaseURL
		}
		if key == "" {
			key = "friday" // Ollama accepts anything, and the SDK refuses an empty key
		}
		provider, err = openaicompat.New(openaicompat.WithBaseURL(base), openaicompat.WithAPIKey(key), openaicompat.WithName(p.ID), openaicompat.WithUserAgent(UserAgent))
	default:
		return nil, fmt.Errorf("%s is not available in the Go engine yet", p.Label)
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w", p.Label, err)
	}
	return provider.LanguageModel(ctx, model)
}

// OpenRouterBase is OpenRouter's Chat Completions endpoint.
const OpenRouterBase = "https://openrouter.ai/api/v1"

// Models is a session's models on one provider: the main one, the small one, and any other a
// role names, opened once each.
type Models struct {
	sel  Selection
	env  Env
	open Opener

	mu    sync.Mutex
	cache map[string]fantasy.LanguageModel
}

// NewModels opens the main model now, so a broken key fails the session at once rather than on
// its first message; others open when first used.
func NewModels(ctx context.Context, sel Selection, env Env, open Opener) (*Models, error) {
	if open == nil {
		open = OpenModel
	}
	m := &Models{sel: sel, env: env, open: open, cache: map[string]fantasy.LanguageModel{}}
	if _, err := m.get(ctx, sel.Model); err != nil {
		return nil, err
	}
	return m, nil
}

// Selection is the provider and model names.
func (m *Models) Selection() Selection {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sel
}

// Main is the session's model.
func (m *Models) Main(ctx context.Context) (fantasy.LanguageModel, error) {
	return m.get(ctx, m.Selection().Model)
}

// For is the model a role or a job asks for: "main" or "" is the session's, "small" the cheap one,
// anything else a model id on the same provider. It returns the model and its id.
func (m *Models) For(ctx context.Context, choice string) (fantasy.LanguageModel, string, error) {
	sel := m.Selection()
	id := sel.Model
	switch strings.TrimSpace(choice) {
	case "", "main":
	case "small":
		id = sel.Small
	default:
		id = strings.TrimSpace(choice)
		if sel.Provider.ID == "free" && !IsFreeModel(id) {
			id = sel.Model // a role must not turn a free session into a paid one
		}
	}
	model, err := m.get(ctx, id)
	return model, id, err
}

// Switch moves the session to another model on the same provider (set_model); the small model
// stays unless it was the old main one.
func (m *Models) Switch(ctx context.Context, model string) error {
	if _, err := m.get(ctx, model); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sel.Small == m.sel.Model {
		m.sel.Small = model
	}
	m.sel.Model = model
	return nil
}

func (m *Models) get(ctx context.Context, id string) (fantasy.LanguageModel, error) {
	m.mu.Lock()
	if model, ok := m.cache[id]; ok {
		m.mu.Unlock()
		return model, nil
	}
	sel := m.sel
	m.mu.Unlock()
	model, err := m.open(ctx, sel, m.env, id)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.cache[id] = model
	m.mu.Unlock()
	return model, nil
}

// DefaultContextLimit is the context window assumed for a model whose window is not known.
const DefaultContextLimit = 128_000

// ContextLimit is ARCHYMEDES_CONTEXT_LIMIT when it is a sensible number, else the default.
func ContextLimit(env Env) int {
	if n, err := strconv.Atoi(env.Get("ARCHYMEDES_CONTEXT_LIMIT")); err == nil && n >= 8_000 {
		return n
	}
	return DefaultContextLimit
}
