package llm

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The published rates this build knows (ported from packages/core/src/providers/price-catalog.ts
// and pricing.ts, WS-50.4), in the currency each provider quotes, per million tokens, dated. A
// model absent here still runs; it is "unpriced" rather than given a neighbour's rate.

// Rate is one dated text-token price record.
type Rate struct {
	Provider, Model string
	Currency        string
	// Input, Output and Cached are major units per million tokens; Cached < 0 when not published.
	Input, Output, Cached float64
	// From and Until are ISO dates; Until is exclusive and "" while the rate is current.
	From, Until string
}

// Prices is what a model costs per million tokens, in micros of Currency.
type Prices struct {
	Currency string
	Input    int64
	Output   int64
	Cached   int64 // -1 when not published
}

const (
	anthropicVerified = "2026-06-24"
	compatVerified    = "2026-06-01"
)

func rate(provider, model string, input, output, cached float64, from string) Rate {
	return Rate{Provider: provider, Model: model, Currency: "USD", Input: input, Output: output, Cached: cached, From: from}
}

// Rates is the catalog. Sonnet 5 had an introductory rate through 2026-08-31.
var Rates = func() []Rate {
	var out []Rate
	for _, m := range []string{"claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"} {
		out = append(out, rate("anthropic", m, 5, 25, 0.5, anthropicVerified))
	}
	intro := rate("anthropic", "claude-sonnet-5", 2, 10, 0.2, anthropicVerified)
	intro.Until = "2026-09-01"
	return append(out,
		rate("anthropic", "claude-fable-5", 10, 50, 1, anthropicVerified),
		rate("anthropic", "claude-sonnet-4-6", 3, 15, 0.3, anthropicVerified),
		rate("anthropic", "claude-haiku-4-5", 1, 5, 0.1, anthropicVerified),
		intro,
		rate("anthropic", "claude-sonnet-5", 3, 15, 0.3, "2026-09-01"),
		rate("google", "gemini-2.5-pro", 1.25, 10, 0.31, compatVerified),
		rate("google", "gemini-2.5-flash", 0.3, 2.5, -1, compatVerified),
		rate("xai", "grok-4", 3, 15, 0.75, compatVerified),
		rate("xai", "grok-4-fast", 0.2, 0.5, -1, compatVerified),
		rate("deepseek", "deepseek-chat", 0.28, 0.42, 0.028, compatVerified),
		rate("deepseek", "deepseek-reasoner", 0.28, 2.19, 0.028, compatVerified),
		rate("mistral", "mistral-large-latest", 2, 6, -1, compatVerified),
		rate("mistral", "mistral-small-latest", 0.2, 0.6, -1, compatVerified),
		rate("groq", "llama-3.3-70b-versatile", 0.59, 0.79, -1, compatVerified),
	)
}()

var versionMarker = regexp.MustCompile(`(?i)-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$`)

// PriceAliases are the ids a model can be priced under, most specific first: a dated snapshot or a
// -latest/-preview pointer is billed as its family. Only version markers are trimmed, at the end.
func PriceAliases(model string) []string {
	aliases := []string{model}
	candidate := model
	for step := 0; step < 3; step++ {
		trimmed := versionMarker.ReplaceAllString(candidate, "")
		if trimmed == candidate || trimmed == "" {
			break
		}
		candidate = trimmed
		aliases = append(aliases, candidate)
	}
	return aliases
}

// Today is the date prices are quoted at.
func Today() string { return time.Now().UTC().Format("2006-01-02") }

// CatalogPrices is what the catalog says provider's model costs on date (YYYY-MM-DD); ok is false
// when it does not know. Free models and local inference cost nothing.
func CatalogPrices(provider, model, date string) (Prices, bool) {
	switch provider {
	case "free":
		if IsFreeModel(model) {
			return Prices{Currency: "USD", Cached: 0}, true
		}
		return Prices{}, false
	case "ollama":
		return Prices{Currency: "USD", Cached: 0}, true
	}
	for _, alias := range PriceAliases(model) {
		var best *Rate
		for i := range Rates {
			r := &Rates[i]
			if r.Provider == provider && r.Model == alias && r.From <= date && (r.Until == "" || date < r.Until) && (best == nil || r.From > best.From) {
				best = r
			}
		}
		if best != nil {
			p := Prices{Currency: best.Currency, Input: micros(best.Input), Output: micros(best.Output), Cached: -1}
			if best.Cached >= 0 {
				p.Cached = micros(best.Cached)
			}
			return p, true
		}
	}
	return Prices{}, false
}

func micros(units float64) int64 {
	v := units * 1_000_000
	if v < 0 {
		return -int64(-v + 0.5)
	}
	return int64(v + 0.5)
}

// DescribePrice is "$3.00/$15.00 per Mtok", or "unpriced".
func DescribePrice(p Prices, ok bool) string {
	if !ok {
		return "unpriced"
	}
	return FormatMoney(p.Input, p.Currency) + "/" + FormatMoney(p.Output, p.Currency) + " per Mtok"
}

// FormatMoney renders micros as money.ts does for the currencies the catalog quotes: USD with two
// decimals (four below a cent), RWF in whole francs, anything else as "CUR 1.23".
func FormatMoney(amount int64, currency string) string {
	units := float64(amount) / 1_000_000
	magnitude := units
	if magnitude < 0 {
		magnitude = -magnitude
	}
	switch currency {
	case "USD":
		digits := 2
		if magnitude > 0 && magnitude < 0.01 {
			digits = 4
		}
		return "$" + grouped(units, 2, digits)
	case "RWF":
		return "RWF " + grouped(units, 0, 0)
	}
	digits := 2
	if magnitude > 0 && magnitude < 0.01 {
		digits = 4
	}
	return currency + " " + grouped(units, 2, digits)
}

// grouped is toLocaleString("en-US") with min and max fraction digits.
func grouped(v float64, minDigits, maxDigits int) string {
	text := strconv.FormatFloat(v, 'f', maxDigits, 64)
	whole, fraction, _ := strings.Cut(text, ".")
	for len(fraction) > minDigits && strings.HasSuffix(fraction, "0") {
		fraction = fraction[:len(fraction)-1]
	}
	negative := strings.HasPrefix(whole, "-")
	whole = strings.TrimPrefix(whole, "-")
	var b strings.Builder
	for i, r := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	out := b.String()
	if negative {
		out = "-" + out
	}
	if fraction != "" {
		out += "." + fraction
	}
	return out
}

// KnownModels are the text models this build knows for a provider: its default first, then the
// catalog's, sorted.
func KnownModels(p Provider) []string {
	var models []string
	for _, r := range Rates {
		if r.Provider == p.ID && r.Model != p.DefaultModel && !slices.Contains(models, r.Model) {
			models = append(models, r.Model)
		}
	}
	slices.Sort(models)
	return append([]string{p.DefaultModel}, models...)
}
