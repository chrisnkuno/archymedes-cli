// Package settings is the Settings list: every setting a person may set, what it offers to pick
// from, how a value is checked, and settings.json, where values are kept. The engine answers
// `_archymedes/settings/list` and `/set` from it, and the interface draws the rows.
//
// Ported from packages/friday-cli/src/platform/settings.ts (WS-50.2) and held to it by the fixtures
// in testdata/, captured from the TypeScript code by tooling/port/settings-fixtures.ts.
package settings

import (
	"slices"
	"sort"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/llm"
)

// Choice is a value that can be picked, with the words shown for it.
type Choice struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// Field is one setting.
type Field struct {
	Key   string
	Label string
	// Section starts a heading at this field; the fields after it belong to it until the next.
	Section string
	// Choices means the value is picked, not typed.
	Choices []Choice
	// Secret values never leave the engine: the client gets whether one is set and a masked form.
	Secret bool
	// URL values are checked as URLs and stored without a trailing slash.
	URL bool
	// Themes offers the interface's themes, which it passes in (List's themes).
	Themes bool
}

// Internal are keys Friday records for itself and never lists: they survive a restart and a save.
// ARCHYMEDES_FREE_PRIVACY_ACK is "yes" once the free-mode privacy notice was shown.
var Internal = []string{"ARCHYMEDES_FREE_PRIVACY_ACK"}

// Lookup finds a field by key.
func Lookup(key string) (Field, bool) {
	i := slices.IndexFunc(Fields, func(f Field) bool { return f.Key == key })
	if i < 0 {
		return Field{}, false
	}
	return Fields[i], true
}

// SectionOf is the heading a field sits under: the nearest field at or above it that names one.
func SectionOf(key string) string {
	section := ""
	for _, f := range Fields {
		if f.Section != "" {
			section = f.Section
		}
		if f.Key == key {
			return section
		}
	}
	return ""
}

// controlLanguages are the languages Friday's words come in, in the order they are offered.
var controlLanguages = []Choice{
	{"en", "English"}, {"zh", "中文"}, {"hi", "हिन्दी"}, {"es", "Español"}, {"fr", "Français"},
	{"ar", "العربية"}, {"bn", "বাংলা"}, {"pt", "Português"}, {"ru", "Русский"}, {"ur", "اردو"},
	{"ja", "日本語"}, {"ko", "한국어"}, {"de", "Deutsch"}, {"id", "Bahasa Indonesia"}, {"vi", "Tiếng Việt"}, {"tr", "Türkçe"},
}

func languageChoices() []Choice { return controlLanguages }

// countryCurrencies are the countries Friday can price in, and the currency each implies.
var countryCurrencies = map[string]string{
	"RW": "RWF", "EG": "EGP", "KE": "KES", "UG": "UGX", "TZ": "TZS", "NG": "NGN", "ZA": "ZAR", "GH": "GHS", "ET": "ETB",
	"US": "USD", "CA": "CAD", "GB": "GBP", "FR": "EUR", "DE": "EUR", "ES": "EUR", "IT": "EUR", "NL": "EUR", "BE": "EUR",
	"CH": "CHF", "SE": "SEK", "NO": "NOK", "DK": "DKK", "PL": "PLN", "CZ": "CZK", "TR": "TRY", "AE": "AED", "SA": "SAR",
	"IL": "ILS", "IN": "INR", "CN": "CNY", "JP": "JPY", "SG": "SGD", "AU": "AUD", "NZ": "NZD", "BR": "BRL", "MX": "MXN",
}

var countryNames = map[string]string{
	"RW": "Rwanda", "EG": "Egypt", "KE": "Kenya", "UG": "Uganda", "TZ": "Tanzania", "NG": "Nigeria", "ZA": "South Africa",
	"GH": "Ghana", "ET": "Ethiopia", "US": "United States", "CA": "Canada", "GB": "United Kingdom", "FR": "France",
	"DE": "Germany", "ES": "Spain", "IT": "Italy", "NL": "Netherlands", "BE": "Belgium", "CH": "Switzerland",
	"SE": "Sweden", "NO": "Norway", "DK": "Denmark", "PL": "Poland", "CZ": "Czechia", "TR": "Türkiye", "AE": "United Arab Emirates",
	"SA": "Saudi Arabia", "IL": "Israel", "IN": "India", "CN": "China", "JP": "Japan", "SG": "Singapore",
	"AU": "Australia", "NZ": "New Zealand", "BR": "Brazil", "MX": "Mexico",
}

// supportedCountries are the country codes, sorted.
func supportedCountries() []string {
	codes := make([]string, 0, len(countryCurrencies))
	for code := range countryCurrencies {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	return codes
}

// countryChoices are sorted by name: someone looking for Rwanda is looking for "Rwanda".
func countryChoices() []Choice {
	var out []Choice
	for _, code := range supportedCountries() {
		out = append(out, Choice{code, countryNames[code] + " (" + code + ") — " + countryCurrencies[code]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	return out
}

func currencyChoices() []Choice {
	seen := map[string]bool{}
	var codes []string
	for _, c := range countryCurrencies {
		if !seen[c] {
			seen[c] = true
			codes = append(codes, c)
		}
	}
	sort.Strings(codes)
	out := make([]Choice, len(codes))
	for i, c := range codes {
		out[i] = Choice{c, c}
	}
	return out
}

// outsideEngines are the person's own installed agents, chosen like providers.
var outsideEngines = []Choice{
	{"claude", "Claude (your subscription, through Claude Code)"},
	{"codex", "Codex (your ChatGPT plan, through the Codex CLI)"},
}

func providerChoices() []Choice {
	var out []Choice
	for _, p := range llm.Providers {
		out = append(out, Choice{p.ID, p.Label})
	}
	return append(out, outsideEngines...)
}

// providerIDs are the ids ARCHYMEDES_PROVIDER accepts, in the order they are listed.
func providerIDs() []string {
	var ids []string
	for _, c := range providerChoices() {
		ids = append(ids, c.Value)
	}
	return ids
}

func isModelProvider(id string) bool {
	return slices.ContainsFunc(llm.Providers, func(p llm.Provider) bool { return p.ID == id })
}

// Mask is how a secret is shown: enough to recognise it, never enough to use it.
func Mask(value string) string {
	switch {
	case value == "":
		return "not set"
	case len([]rune(value)) <= 8:
		return "set (hidden)"
	}
	r := []rune(value)
	return string(r[:3]) + "…" + string(r[len(r)-3:])
}

func lower(s string) string { return strings.ToLower(s) }
