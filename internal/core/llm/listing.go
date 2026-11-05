package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// What each provider says it has: its /v1/models listing, read with the key it expects, and kept
// in models.json beside settings.json for six hours (model-list.ts and model-fetch.ts; WS-50.3).

// Getter does one GET and returns the status and body. Tests replace it; DefaultGetter is the network.
type Getter func(ctx context.Context, url string, headers map[string]string) (status int, body []byte, err error)

// maxListingBytes bounds a listing: a catalog is data, never a reason to hold gigabytes.
const maxListingBytes = 8 << 20

var listingClient = &http.Client{
	// Never followed: a listing that redirects could carry a key to another host.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// DefaultGetter is a plain GET over the network.
func DefaultGetter(ctx context.Context, url string, headers map[string]string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("User-Agent", UserAgent)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := listingClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxListingBytes+1))
	if err == nil && len(body) > maxListingBytes {
		err = errors.New("catalog exceeds size limit")
	}
	return resp.StatusCode, body, err
}

// getJSON reads a JSON document; a status that is not 2xx is an error naming it.
func getJSON(ctx context.Context, get Getter, url string, headers map[string]string) (any, error) {
	if headers == nil {
		headers = map[string]string{"accept": "application/json"}
	}
	status, body, err := get(ctx, url, headers)
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		return nil, fmt.Errorf("catalog returned HTTP %d", status)
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, err
	}
	return v, nil
}

// ModelsURL joins a base URL to the models path without doubling a trailing /v1.
func ModelsURL(base string) string {
	trimmed := strings.TrimRight(base, "/")
	if strings.HasSuffix(trimmed, "/v1") {
		return trimmed + "/models"
	}
	return trimmed + "/v1/models"
}

// Endpoint is where a provider's listing lives and how the key goes with it.
type Endpoint struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

var listingDefaults = map[string]string{
	"google":   "https://generativelanguage.googleapis.com/v1beta/openai",
	"xai":      "https://api.x.ai/v1",
	"deepseek": "https://api.deepseek.com/v1",
	"mistral":  "https://api.mistral.ai/v1",
	"groq":     "https://api.groq.com/openai/v1",
}

// ModelsEndpoint is where provider lists its models; ok is false when it cannot be asked (no key,
// or Archymedes Cloud, whose routed model is `auto`). OpenRouter's and Ollama's need no key.
func ModelsEndpoint(provider string, env Env) (Endpoint, bool) {
	switch provider {
	case "free":
		return Endpoint{URL: FreeBaseURL + "/models", Headers: map[string]string{}}, true
	case "openrouter":
		headers := map[string]string{}
		if key := env.Get("OPENROUTER_API_KEY"); key != "" {
			headers["authorization"] = "Bearer " + key
		}
		return Endpoint{URL: ModelsURL(firstNonEmpty(env.Get("OPENROUTER_BASE_URL"), OpenRouterBase)), Headers: headers}, true
	case "anthropic":
		key := env.Get("ANTHROPIC_API_KEY")
		if key == "" {
			return Endpoint{}, false
		}
		return Endpoint{URL: ModelsURL(firstNonEmpty(env.Get("ANTHROPIC_BASE_URL"), "https://api.anthropic.com")) + "?limit=1000",
			Headers: map[string]string{"x-api-key": key, "anthropic-version": "2023-06-01"}}, true
	case "openai":
		key := env.Get("OPENAI_API_KEY")
		if key == "" {
			return Endpoint{}, false
		}
		return Endpoint{URL: ModelsURL(firstNonEmpty(env.Get("OPENAI_BASE_URL"), "https://api.openai.com")), Headers: map[string]string{"authorization": "Bearer " + key}}, true
	case "google", "xai", "deepseek", "mistral", "groq", "openai-compatible":
		prefix := strings.ToUpper(strings.ReplaceAll(provider, "-", "_"))
		key := env.Get(prefix + "_API_KEY")
		base := firstNonEmpty(env.Get(prefix+"_BASE_URL"), listingDefaults[provider])
		if key == "" || base == "" {
			return Endpoint{}, false
		}
		return Endpoint{URL: ModelsURL(base), Headers: map[string]string{"authorization": "Bearer " + key}}, true
	case "ollama":
		return Endpoint{URL: ModelsURL(firstNonEmpty(env.Get("OLLAMA_BASE_URL"), "http://localhost:11434/v1")), Headers: map[string]string{}}, true
	}
	return Endpoint{}, false
}

// ParseModelsResponse takes the ids out of a listing: {data:[…]}, a bare array or {models:[…]},
// each entry a string or an object with id or name. Duplicates once, in order.
func ParseModelsResponse(body any) []string {
	var items []any
	switch b := body.(type) {
	case []any:
		items = b
	case map[string]any:
		if d, ok := b["data"].([]any); ok {
			items = d
		} else if m, ok := b["models"].([]any); ok {
			items = m
		}
	}
	ids := []string{}
	for _, item := range items {
		id := ""
		switch e := item.(type) {
		case string:
			id = e
		case map[string]any:
			if s, ok := e["id"].(string); ok {
				id = s
			} else if s, ok := e["name"].(string); ok {
				id = s
			}
		}
		if id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids
}

var nonChat = regexp.MustCompile(`(?i)embed|moderation|whisper|tts|orpheus|audio|dall-?e|^stable-|image|vision-encoder|rerank|guard|^text-similarity|^text-search|transcribe|realtime|^omni-moderation|^davinci|^babbage|codex-mini`)

// IsConversational is false for ids that cannot hold a conversation (embeddings, speech, images…).
func IsConversational(id string) bool { return !nonChat.MatchString(id) }

// Listed is one provider's answer: its models, or why there are none.
type Listed struct {
	Provider    string
	Models      []string
	Error       string
	FreeCatalog *FreeCatalog
}

// FetchProviderModels asks one provider what it has, within timeout. It never fails: a failure is
// the Error.
func FetchProviderModels(ctx context.Context, provider string, env Env, get Getter, timeout time.Duration) Listed {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if provider == "free" {
		modelsURL := ""
		if _, gateway := FreeAccess(env); gateway != "" {
			modelsURL = gateway + "/v1/models"
		}
		catalog, err := FetchFreeCatalog(ctx, get, modelsURL, time.Now().UnixMilli())
		if err != nil {
			return Listed{Provider: provider, Models: []string{}, Error: "Free model catalog unavailable; retry /models refresh. Cached entries may be stale."}
		}
		out := Listed{Provider: provider, Models: []string{}, FreeCatalog: &catalog}
		for _, m := range catalog.Models {
			if m.Eligible {
				out.Models = append(out.Models, m.ID)
			}
		}
		out.Error = strings.Join(catalog.Warnings, "; ")
		return out
	}
	endpoint, ok := ModelsEndpoint(provider, env)
	if !ok {
		return Listed{Provider: provider, Models: []string{}, Error: "no key configured"}
	}
	status, body, err := get(ctx, endpoint.URL, endpoint.Headers)
	switch {
	case errors.Is(err, context.DeadlineExceeded) || (err != nil && ctx.Err() != nil):
		return Listed{Provider: provider, Models: []string{}, Error: "timed out"}
	case err != nil:
		return Listed{Provider: provider, Models: []string{}, Error: err.Error()}
	case status < 200 || status > 299:
		return Listed{Provider: provider, Models: []string{}, Error: "provider returned " + strconv.Itoa(status)}
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return Listed{Provider: provider, Models: []string{}, Error: err.Error()}
	}
	models := []string{}
	for _, id := range ParseModelsResponse(v) {
		if IsConversational(id) {
			models = append(models, id)
		}
	}
	slices.Sort(models)
	return Listed{Provider: provider, Models: models}
}

// ModelCache is models.json: each provider's last listing, and the free catalog.
type ModelCache struct {
	FreeCatalog *FreeCatalog        `json:"freeCatalog,omitempty"`
	FetchedAt   int64               `json:"fetchedAt"`
	Models      map[string][]string `json:"models"`
}

// ModelCacheTTL is how long a listing is trusted.
const ModelCacheTTL = 6 * time.Hour

// ModelCacheFile is models.json in the config directory.
func ModelCacheFile(configDir string) string { return filepath.Join(configDir, "models.json") }

var cacheMu sync.Mutex

// ReadModelCache is the cache, or nil when there is none that reads.
func ReadModelCache(configDir string) *ModelCache {
	data, err := os.ReadFile(ModelCacheFile(configDir))
	if err != nil {
		return nil
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil {
		return nil
	}
	var cache ModelCache
	if json.Unmarshal(data, &cache) != nil || raw["fetchedAt"] == nil || cache.Models == nil {
		return nil
	}
	return &cache
}

// Fresh is a cache fetched within the TTL, and not in the future (a clock that moved).
func (c *ModelCache) Fresh(now time.Time) bool {
	if c == nil {
		return false
	}
	ms := now.UnixMilli()
	return c.FetchedAt <= ms && ms-c.FetchedAt < ModelCacheTTL.Milliseconds()
}

// WriteModelCache replaces the cache in one rename; a failure costs a fetch next time.
func WriteModelCache(configDir string, cache ModelCache) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	writeModelCache(configDir, cache)
}

func writeModelCache(configDir string, cache ModelCache) {
	if configDir == "" {
		return
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return
	}
	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return
	}
	tmp, err := os.CreateTemp(configDir, "models.json.*.tmp")
	if err != nil {
		return
	}
	_, err = tmp.Write(append(data, '\n'))
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o600)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), ModelCacheFile(configDir))
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
}

// RememberModels puts one provider's listing into the cache, keeping the rest.
func RememberModels(configDir, provider string, models []string, now time.Time) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	cache := ReadModelCache(configDir)
	next := ModelCache{FetchedAt: now.UnixMilli(), Models: map[string][]string{}}
	if cache != nil {
		next.FetchedAt, next.FreeCatalog = cache.FetchedAt, cache.FreeCatalog
		for k, v := range cache.Models {
			next.Models[k] = v
		}
	}
	next.Models[provider] = models
	writeModelCache(configDir, next)
}

// listingTimeout bounds one provider's answer while the picker waits.
const listingTimeout = 4 * time.Second

// LoadLiveModels asks providers in parallel and caches what they said. A failed free listing keeps
// the last good one and its date.
func LoadLiveModels(ctx context.Context, providers []string, env Env, configDir string, get Getter, now time.Time) (map[string][]string, []Listed) {
	previous := ReadModelCache(configDir)
	results := make([]Listed, len(providers))
	var wg sync.WaitGroup
	for i, p := range providers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = FetchProviderModels(ctx, p, env, get, listingTimeout)
		}()
	}
	wg.Wait()
	models := map[string][]string{}
	var failed []Listed
	var free *Listed
	for i := range results {
		r := results[i]
		if len(r.Models) > 0 {
			models[r.Provider] = r.Models
		}
		if r.Provider == "free" {
			free = &results[i]
		}
		if r.Error != "" {
			failed = append(failed, r)
		}
	}
	if free != nil && free.FreeCatalog == nil && previous != nil && previous.Models["free"] != nil {
		models["free"] = previous.Models["free"]
	}
	if len(models) > 0 && !(free != nil && free.FreeCatalog == nil) {
		cache := ModelCache{FetchedAt: now.UnixMilli(), Models: models}
		if free != nil {
			cache.FreeCatalog = free.FreeCatalog
		} else if previous != nil {
			cache.FreeCatalog = previous.FreeCatalog
		}
		WriteModelCache(configDir, cache)
	}
	return models, failed
}

// Requirements is what a provider still needs, as the Providers app and the model list say it:
// free mode counts a free gateway as well as an OpenRouter key.
func Requirements(p Provider, env Env) []string {
	if p.ID == "free" {
		if key, gateway := FreeAccess(env); key != "" || gateway != "" {
			return []string{}
		}
		return []string{"ARCHYMEDES_FREE_GATEWAY_URL (a self-hosted free gateway) or OPENROUTER_API_KEY"}
	}
	missing := Missing(p, env)
	if missing == nil {
		missing = []string{}
	}
	return missing
}

// Fetchable are the providers worth asking for a listing: those with what they need (never
// Archymedes Cloud, which lists nothing).
func Fetchable(env Env) []string {
	var out []string
	for _, p := range Providers {
		if p.ID != "archymedes-cloud" && len(Requirements(p, env)) == 0 {
			out = append(out, p.ID)
		}
	}
	return out
}
