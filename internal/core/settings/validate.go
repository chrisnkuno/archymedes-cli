package settings

import (
	"math"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"golang.org/x/text/currency"

	"github.com/chrisnkuno/friday-cli/internal/core/llm"
)

// enums are settings whose answer is one of a few words: checked case-insensitively and stored
// lower case, so `ON` in a hand-edited settings.json means `on`.
var enums = map[string][]string{
	"ARCHYMEDES_CODE_COLORS":       {"vscode", "theme"},
	"ARCHYMEDES_CODE_LINE_NUMBERS": {"on", "off"},
	"ARCHYMEDES_TOKEN_SAVER":       {"on", "off"},
	"ARCHYMEDES_TOKEN_METER":       {"on", "off"},
	"ARCHYMEDES_SIMPLE":            {"on", "off"},
	"ARCHYMEDES_RESUME":            {"ask", "always", "never"},
	"ARCHYMEDES_WEB_SEARCH":        {"auto", "brave", "tavily", "searxng", "duckduckgo", "off"},
	"ARCHYMEDES_EDITOR_AUTOSAVE":   {"on", "off"},
	"ARCHYMEDES_SUGGEST":           {"on", "off"},
	"ARCHYMEDES_SUGGEST_MODEL":     {"on", "off"},
	"ARCHYMEDES_AUTO_UPDATE":       {"install", "check", "off"},
	"ARCHYMEDES_TELEMETRY":         {"on", "off"},
	"ARCHYMEDES_NOTIFY":            {"auto", "always", "off"},
	"ARCHYMEDES_VIM":               {"on", "off"},
	"ARCHYMEDES_REASONING":         {"auto", "minimal", "low", "medium", "high", "xhigh", "max"},
}

var (
	themeName     = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	isoCurrency   = regexp.MustCompile(`^[A-Za-z]{3}$`)
	countryCode   = regexp.MustCompile(`^[A-Z]{2}$`)
	explicitModel = regexp.MustCompile(`(?i)^([a-z-]+)[:/]\S+$`)
	decimal       = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)
	freeModelID   = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*:free$`)
)

const isoCurrencyRefusal = "Currency must be a three-letter ISO code such as USD."

// Validate checks a value for a setting and returns what is stored, or a refusal: a sentence
// saying what to enter instead, shown to the person as it is.
func Validate(key, raw string) (value, refusal string) {
	value = strings.TrimSpace(raw)
	field, ok := Lookup(key)
	if !ok {
		return "", "No setting named " + key + "."
	}
	if value == "" {
		return "", "Value cannot be empty. Enter - in the menu to clear it."
	}
	if allowed, ok := enums[key]; ok {
		if !slices.Contains(allowed, lower(value)) {
			return "", "Choose one of: " + strings.Join(allowed, ", ") + "."
		}
		return lower(value), ""
	}
	switch {
	case key == "ARCHYMEDES_THEME":
		// A theme file the person wrote is as valid as a built-in one: its shape is checked here,
		// its existence when the interface loads it.
		if !themeName.MatchString(value) {
			return "", "Theme names are letters, digits, - and _ — see /theme list."
		}
		return lower(value), ""
	case key == "FREE_MODEL" && !isFreeModelID(value):
		return "", "Choose openrouter/free or an exact publisher/model:free ID."
	case field.URL:
		return validURL(value)
	}
	if strings.HasSuffix(key, "PER_MILLION") && !nonNegative(value) {
		return "", "Price must be a non-negative number."
	}
	switch key {
	case "ARCHYMEDES_LOW_BALANCE", "ARCHYMEDES_CRITICAL_BALANCE", "ARCHYMEDES_ACCOUNT_BALANCE":
		if !nonNegative(value) {
			return "", "Must be a non-negative number."
		}
	case "ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY", "ARCHYMEDES_CLOUD_CURRENCY":
		if !isoCurrency.MatchString(value) {
			return "", isoCurrencyRefusal
		}
	case "ARCHYMEDES_CLOUD_MAXIMUM_MICROS":
		if n, ok := number(value); !ok || n <= 0 || n != math.Trunc(n) || n > 1<<53-1 {
			return "", "Maximum must be a positive integer number of micros."
		}
	case "ARCHYMEDES_CLOUD_QUALITY_FLOOR":
		if n, ok := number(value); !ok || n < 0 || n > 1 {
			return "", "Quality floor must be between 0 and 1."
		}
	case "MODEL_PRICE_CURRENCY":
		if !isoCurrency.MatchString(value) {
			return "", isoCurrencyRefusal
		}
		return strings.ToUpper(value), ""
	case "ARCHYMEDES_LANGUAGE":
		if !slices.ContainsFunc(controlLanguages, func(c Choice) bool { return c.Value == lower(value) }) {
			codes := make([]string, len(controlLanguages))
			for i, c := range controlLanguages {
				codes[i] = c.Value
			}
			return "", "Choose one of: " + strings.Join(codes, ", ") + "."
		}
	case "ARCHYMEDES_PROVIDER":
		if !slices.Contains(providerIDs(), lower(value)) {
			return "", "Choose one of: " + strings.Join(providerIDs(), ", ") + "."
		}
		return lower(value), ""
	case "ARCHYMEDES_PROFILE":
		if !llm.ProfileName.MatchString(value) {
			return "", "A profile name is letters, digits, dots, dashes and underscores, as its file is named (profiles/<name>.json)."
		}
		return value, ""
	case "ARCHYMEDES_ENGINE":
		if v := lower(value); v != "go" && v != "ts" {
			return "", "Choose go or ts."
		}
		return lower(value), ""
	case "ARCHYMEDES_JEV", "ARCHYMEDES_TEST_FIRST":
		if v := lower(value); v != "on" && v != "off" {
			return "", "Choose on or off."
		}
		return lower(value), ""
	case "ARCHYMEDES_FALLBACK_MODEL":
		if lower(value) != "ask" {
			m := explicitModel.FindStringSubmatch(value)
			if m == nil || !isModelProvider(lower(m[1])) {
				return "", "Choose ask, or enter an explicit provider:model such as openai:gpt-5.4-mini."
			}
		}
	case "ARCHYMEDES_COUNTRY":
		country := strings.ToUpper(value)
		if !countryCode.MatchString(country) {
			return "", "Enter a two-letter ISO country code, such as RW or EG."
		}
		// Refused rather than saved and ignored: a location matters for its currency.
		if _, ok := countryCurrencies[country]; !ok {
			return "", "No local currency is known for " + country + ". Set the display currency directly instead, or choose one of: " + strings.Join(supportedCountries(), ", ") + "."
		}
		return country, ""
	case "ARCHYMEDES_CURRENCY":
		code := strings.ToUpper(value)
		if _, err := currency.ParseISO(code); err != nil || !isoCurrency.MatchString(code) {
			return "", code + " is not a currency Friday can convert to. Leave this empty to use the one your location implies."
		}
		return code, ""
	}
	return value, ""
}

// validURL accepts https anywhere and http on this computer, and drops a trailing slash.
func validURL(value string) (string, string) {
	u, err := url.Parse(value)
	incomplete := "Enter a complete URL, for example https://api.example.com/v1."
	if err != nil || u.Scheme == "" {
		return "", incomplete
	}
	u.Scheme = lower(u.Scheme)
	u.Host = lower(u.Host)
	host := u.Hostname()
	// [::1] counts as this computer, as the TypeScript rule meant to (its URL's hostname kept the brackets).
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	// Any scheme:rest is a URL (WHATWG), so the scheme is judged before the host is required.
	if u.Scheme != "https" && !(local && u.Scheme == "http") {
		return "", "URLs must use HTTPS (HTTP is allowed only for localhost)."
	}
	if u.Host == "" {
		return "", incomplete
	}
	if u.Path == "" {
		u.Path = "/"
	}
	return strings.TrimSuffix(u.String(), "/"), ""
}

// number reads a value as JavaScript's Number() does: decimal with an optional exponent, or an
// integer in 0x, 0o or 0b; nothing else (no hex floats, no underscores), and only finite values.
func number(value string) (float64, bool) {
	v := strings.TrimSpace(value)
	if len(v) > 2 && v[0] == '0' {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[v[1]]
		if base != 0 {
			n, err := strconv.ParseUint(v[2:], base, 64)
			return float64(n), err == nil && !strings.Contains(v, "_")
		}
	}
	if !decimal.MatchString(v) {
		return 0, false
	}
	n, err := strconv.ParseFloat(v, 64)
	return n, err == nil && !math.IsInf(n, 0)
}

func nonNegative(value string) bool {
	n, ok := number(value)
	return ok && n >= 0
}

// isFreeModelID is free mode's rule: the free router, or an exact publisher/model:free.
func isFreeModelID(model string) bool {
	return model == "openrouter/free" || (len(model) <= 256 && freeModelID.MatchString(model))
}
