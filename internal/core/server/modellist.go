package server

import (
	"context"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/llm"
)

// The model picker's list (WS-50.4, from server/models.ts): every model of every provider, the
// ones that cannot be used yet included and locked, with what each lacks, its price, whether it is
// free, and how a free model measured as an agent. The providers' own listings are asked when the
// cached ones are stale, or always with refresh; OpenRouter's public listing, which carries every
// free model, is asked even without a key. ARCHYMEDES_MODELS_OFFLINE keeps it off the network
// unless asked to refresh.

// modelChoice is one model in the picker.
type modelChoice struct {
	Provider      string   `json:"provider"`
	ProviderLabel string   `json:"providerLabel"`
	Model         string   `json:"model"`
	IsDefault     bool     `json:"isDefault"`
	Live          bool     `json:"live"`
	Price         string   `json:"price"`
	Free          bool     `json:"free"`
	Locked        bool     `json:"locked"`
	Missing       []string `json:"missing"`
	Small         bool     `json:"small"`
	Fit           string   `json:"fit,omitempty"`
	FitNote       string   `json:"fitNote,omitempty"`
}

type unconfigured struct {
	Provider string   `json:"provider"`
	Label    string   `json:"label"`
	Missing  []string `json:"missing"`
}

var offlineWords = regexp.MustCompile(`(?i)^(1|true|on|yes)$`)

// publicListings are asked even without a key.
var publicListings = []string{"free", "openrouter"}

// models answers `_archymedes/models`.
func (s *Server) models(ctx context.Context, params json.RawMessage) (any, error) {
	var p struct {
		Refresh any `json:"refresh"`
	}
	_ = json.Unmarshal(params, &p)
	env, now := s.env(), time.Now()
	offline := offlineWords.MatchString(env.Get("ARCHYMEDES_MODELS_OFFLINE"))
	cached := llm.ReadModelCache(s.opts.ConfigDir)
	var live map[string][]string
	if cached.Fresh(now) {
		live = cached.Models
	}
	errors := []string{}
	if p.Refresh == true || (live == nil && !offline) {
		asked := llm.Fetchable(env)
		if !offline {
			for _, id := range publicListings {
				if !slices.Contains(asked, id) {
					asked = append(asked, id)
				}
			}
		}
		loaded, failed := llm.LoadLiveModels(ctx, asked, env, s.opts.ConfigDir, s.net(), now)
		if len(loaded) > 0 {
			merged := map[string][]string{}
			base := live
			if base == nil && cached != nil {
				base = cached.Models
			}
			for k, v := range base {
				merged[k] = v
			}
			for k, v := range loaded {
				merged[k] = v
			}
			live = merged
		}
		for _, f := range failed {
			// Ollama needs no key, so it is always asked: its refusal is news only to someone who
			// pointed Friday at an Ollama server.
			if f.Provider != "ollama" || env.Get("OLLAMA_BASE_URL") != "" {
				errors = append(errors, f.Provider+": "+f.Error)
			}
		}
	}
	if live == nil && cached != nil {
		live = cached.Models
	}

	var ready, locked []modelChoice
	missingRows := []unconfigured{}
	free := live["free"] // a free model is listed once, under the free provider
	today := llm.Today()
	for _, provider := range llm.Providers {
		if provider.ID == "archymedes-cloud" {
			continue
		}
		missing := llm.Requirements(provider, env)
		if len(missing) > 0 {
			missingRows = append(missingRows, unconfigured{provider.ID, provider.Label, missing})
		}
		known := llm.KnownModels(provider)
		var extra []string
		for _, m := range live[provider.ID] {
			if !slices.Contains(known, m) && (provider.ID != "free" || llm.IsFreeModel(m)) && !(provider.ID == "openrouter" && slices.Contains(free, m)) {
				extra = append(extra, m)
			}
		}
		slices.Sort(extra)
		preferred := firstNonEmpty(env.Get(provider.Prefix()+"_MODEL"), provider.DefaultModel)
		for _, model := range append(known, extra...) {
			prices, priced := llm.CatalogPrices(provider.ID, model, today)
			isFree := provider.ID == "free" || strings.HasSuffix(model, ":free") || (priced && prices.Input == 0 && prices.Output == 0)
			price := llm.DescribePrice(prices, priced)
			if isFree {
				price = "free"
			}
			c := modelChoice{Provider: provider.ID, ProviderLabel: provider.Label, Model: model, IsDefault: model == preferred,
				Live: !slices.Contains(known, model), Price: price, Free: isFree, Locked: len(missing) > 0, Missing: missing, Small: llm.IsSmallModel(model)}
			if model != llm.FreeRouter && llm.IsFreeModel(model) {
				fit := llm.FreeProfile(model)
				c.Fit, c.FitNote = fit.Fit, fit.Note
			}
			if c.Locked {
				locked = append(locked, c)
			} else {
				ready = append(ready, c)
			}
		}
	}
	choices := append(ready, locked...)
	// Claude's and Codex's models: usable once that engine is ready, shown (locked) before.
	for _, r := range []readiness{s.claudeReadiness(ctx, env, false), s.codexReadiness(ctx, env, false)} {
		row := r.row(env)
		var theirs []modelChoice
		for _, model := range r.models() {
			theirs = append(theirs, modelChoice{Provider: r.provider, ProviderLabel: r.label, Model: model, IsDefault: model == firstNonEmpty(row.Model, "default"),
				Price: r.price(), Locked: !r.ready, Missing: row.Missing, Small: r.provider == "claude" && model == "haiku"})
		}
		var usable, rest []modelChoice
		for _, c := range choices {
			if c.Locked {
				rest = append(rest, c)
			} else {
				usable = append(usable, c)
			}
		}
		if r.ready {
			choices = append(append(usable, theirs...), rest...)
		} else {
			choices = append(append(usable, rest...), theirs...)
			missingRows = append(missingRows, unconfigured{r.provider, r.label, row.Missing})
		}
	}
	return map[string]any{"choices": choices, "unconfigured": missingRows, "errors": errors, "providers": len(llm.Providers)}, nil
}
