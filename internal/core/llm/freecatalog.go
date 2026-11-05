package llm

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
)

// The free-model catalog (free-catalog.ts, free-catalog-fetch.ts; WS-50.4): OpenRouter's own
// listing decides which `:free` models free mode may use (zero prices, text output, tool calls, a
// known context), and ClawLabsAI's discovery list only adds claims beside them. Missing metadata
// fails closed.

const (
	FreeBaseURL      = "https://openrouter.ai/api/v1"
	FreeDiscoveryURL = "https://raw.githubusercontent.com/ClawLabsAI/free-ai-models/main/data/models.json"
	freeMaxRecords   = 10_000
)

// FreeReasoning is what OpenRouter's listing says about a model's reasoning.
type FreeReasoning struct {
	Mandatory      bool     `json:"mandatory"`
	DefaultEnabled *bool    `json:"defaultEnabled,omitempty"`
	Efforts        []string `json:"efforts,omitempty"`
}

// FreeModel is one model of the free catalog.
type FreeModel struct {
	Reasoning     *FreeReasoning `json:"reasoning,omitempty"`
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Provider      string         `json:"provider"`
	ContextWindow *int64         `json:"context_window"`
	MaxOutput     *int64         `json:"max_output"`
	Modalities    []string       `json:"modalities"`
	RateLimit     string         `json:"rate_limit"`
	Source        string         `json:"source"`
	Eligible      bool           `json:"eligible"`
	Reason        string         `json:"reason,omitempty"`
	// Discovery is the third party's claims, kept apart from OpenRouter's facts.
	Discovery *FreeModel `json:"discovery,omitempty"`
}

// FreeCatalog is the merged catalog as the model cache keeps it.
type FreeCatalog struct {
	FetchedAt int64       `json:"fetchedAt"`
	Models    []FreeModel `json:"models"`
	Warnings  []string    `json:"warnings"`
}

func object(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

var controlChars = regexp.MustCompile("[\u0000-\u001f\u007f-\u009f]")

func label(v any, fallback string) string {
	s, ok := v.(string)
	if !ok {
		return fallback
	}
	s = strings.TrimSpace(controlChars.ReplaceAllString(s, ""))
	if r := []rune(s); len(r) > 512 {
		s = string(r[:512])
	}
	return s
}

func limitOf(v any) *int64 {
	f, ok := v.(float64)
	if !ok || f <= 0 || f != float64(int64(f)) || f > 9007199254740991 {
		return nil
	}
	n := int64(f)
	return &n
}

func stringList(v any) []string {
	items, _ := v.([]any)
	out := []string{}
	for _, item := range items {
		if s, ok := item.(string); ok {
			s = label(s, "")
			if !slices.Contains(out, s) {
				out = append(out, s)
			}
		}
	}
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

func entries(body any, key string) ([]any, error) {
	items, ok := object(body)[key].([]any)
	if !ok || len(items) > freeMaxRecords {
		return nil, fmt.Errorf("invalid or oversized free model catalog")
	}
	return items, nil
}

var discoveryID = regexp.MustCompile(`(?i)^[a-z0-9._:/-]+$`)

func sourceURL(v any) string {
	s, _ := v.(string)
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.User != nil || (u.Hostname() != "openrouter.ai" && u.Hostname() != "pollinations.ai") {
		return ""
	}
	return u.String()
}

// dedupe keeps models in first-seen order, dropping every id seen twice: a duplicate cannot win
// over another source's facts.
func dedupe(models []FreeModel) []FreeModel {
	count := map[string]int{}
	for _, m := range models {
		count[m.ID]++
	}
	var out []FreeModel
	seen := map[string]bool{}
	for _, m := range models {
		if count[m.ID] == 1 && !seen[m.ID] {
			out = append(out, m)
			seen[m.ID] = true
		}
	}
	return out
}

// ParseFreeDiscovery reads ClawLabsAI's list: claims only, never eligible.
func ParseFreeDiscovery(body any) ([]FreeModel, error) {
	items, err := entries(body, "models")
	if err != nil {
		return nil, err
	}
	var models []FreeModel
	for _, item := range items {
		row := object(item)
		id, source := label(row["id"], ""), sourceURL(row["source"])
		if id == "" || source == "" || !discoveryID.MatchString(id) {
			continue
		}
		models = append(models, FreeModel{
			ID: id, Name: label(row["name"], id), Provider: label(row["provider"], "Unknown"),
			ContextWindow: limitOf(row["context_window"]), MaxOutput: limitOf(row["max_output"]),
			Modalities: stringList(row["modalities"]), RateLimit: label(row["rate_limit"], "unknown"), Source: source,
			Reason: "Not verified as a free OpenRouter tool model",
		})
	}
	return dedupe(models), nil
}

var effortWords = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

func parseReasoning(v any) *FreeReasoning {
	row := object(v)
	mandatory, ok := row["mandatory"].(bool)
	if !ok {
		return nil
	}
	r := &FreeReasoning{Mandatory: mandatory}
	if d, ok := row["default_enabled"].(bool); ok {
		r.DefaultEnabled = &d
	}
	for _, e := range stringList(row["supported_efforts"]) {
		if slices.Contains(effortWords, e) {
			r.Efforts = append(r.Efforts, e)
		}
	}
	return r
}

var zeroText = regexp.MustCompile(`^0(?:\.0+)?$`)

func zero(v any) bool {
	switch x := v.(type) {
	case float64:
		return x == 0
	case string:
		return zeroText.MatchString(x)
	}
	return false
}

// ParseFreeOpenRouter reads OpenRouter's /models: only explicitly zero-priced, text-producing
// tool models with a known context are eligible.
func ParseFreeOpenRouter(body any) ([]FreeModel, error) {
	items, err := entries(body, "data")
	if err != nil {
		return nil, err
	}
	var models []FreeModel
	for _, item := range items {
		row := object(item)
		id, ok := row["id"].(string)
		if !ok || !IsFreeModel(id) {
			continue
		}
		pricing, architecture := object(row["pricing"]), object(row["architecture"])
		context := limitOf(row["context_length"])
		request, hasRequest := pricing["request"]
		reason := ""
		switch {
		case !zero(pricing["prompt"]) || !zero(pricing["completion"]) || (hasRequest && !zero(request)):
			reason = "Zero pricing not confirmed"
		case !slices.Contains(stringList(architecture["output_modalities"]), "text"):
			reason = "No text output"
		case !slices.Contains(stringList(row["supported_parameters"]), "tools"):
			reason = "Tool calling not confirmed"
		case context == nil:
			reason = "Context limit unknown"
		}
		provider, _, _ := strings.Cut(id, "/")
		models = append(models, FreeModel{
			Reasoning: parseReasoning(row["reasoning"]),
			ID:        id, Name: label(row["name"], id), Provider: provider, ContextWindow: context,
			MaxOutput: limitOf(object(row["top_provider"])["max_completion_tokens"]), Modalities: stringList(architecture["input_modalities"]),
			RateLimit: "OpenRouter account quotas apply", Source: "https://openrouter.ai/" + id,
			Eligible: reason == "", Reason: reason,
		})
	}
	return dedupe(models), nil
}

// MergeFreeCatalog lays the live listing over discovery's claims, by id, sorted.
func MergeFreeCatalog(live, discovery []FreeModel, fetchedAt int64, warnings []string) FreeCatalog {
	byID := map[string]FreeModel{}
	for _, m := range discovery {
		byID[m.ID] = m
	}
	for _, m := range live {
		if claimed, ok := byID[m.ID]; ok {
			claims := claimed
			claims.Eligible, claims.Reason, claims.Discovery = false, "", nil
			m.Discovery = &claims
		}
		byID[m.ID] = m
	}
	models := make([]FreeModel, 0, len(byID))
	for _, m := range byID {
		models = append(models, m)
	}
	slices.SortFunc(models, func(a, b FreeModel) int { return localeCompare(a.ID, b.ID) })
	if warnings == nil {
		warnings = []string{}
	}
	return FreeCatalog{FetchedAt: fetchedAt, Models: models, Warnings: warnings}
}

// localeCompare approximates JavaScript's localeCompare for model ids: letters and digits before
// punctuation, case second.
func localeCompare(a, b string) int {
	key := func(s string) string {
		var out strings.Builder
		for _, r := range strings.ToLower(s) {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
				out.WriteRune(r)
			}
		}
		return out.String()
	}
	if c := strings.Compare(key(a), key(b)); c != 0 {
		return c
	}
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}
	return strings.Compare(a, b)
}

// FetchFreeCatalog reads the public listings (no credential ever goes with them): OpenRouter's, or
// a gateway's when modelsURL names it, and discovery's beside it. Discovery failing only adds a
// warning.
func FetchFreeCatalog(ctx context.Context, get Getter, modelsURL string, now int64) (FreeCatalog, error) {
	if modelsURL == "" {
		modelsURL = FreeBaseURL + "/models"
	}
	var (
		wg                 sync.WaitGroup
		liveBody, discBody any
		liveErr, discErr   error
	)
	wg.Add(2)
	go func() { defer wg.Done(); liveBody, liveErr = getJSON(ctx, get, modelsURL, nil) }()
	go func() { defer wg.Done(); discBody, discErr = getJSON(ctx, get, FreeDiscoveryURL, nil) }()
	wg.Wait()
	if liveErr != nil {
		return FreeCatalog{}, liveErr
	}
	live, err := ParseFreeOpenRouter(liveBody)
	if err != nil {
		return FreeCatalog{}, err
	}
	var warnings []string
	var discovery []FreeModel
	if discErr == nil {
		discovery, discErr = ParseFreeDiscovery(discBody)
	}
	if discErr != nil {
		warnings = append(warnings, "ClawLabsAI discovery unavailable; showing verified OpenRouter metadata only")
		discovery = nil
	}
	return MergeFreeCatalog(live, discovery, now, warnings), nil
}
