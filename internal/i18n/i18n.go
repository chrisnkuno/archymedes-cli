// Package i18n is the interface's text in the person's language: one JSON catalog per language
// (locales/<lang>.json, embedded), English as the source every other language falls back to, key by
// key. See docs/continuation/LANGUAGES.md.
package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed locales/*.json
var locales embed.FS

// Supported are the languages a person can choose, by code. A code without a catalog yet reads as
// English everywhere, so a language can be offered before its translation is complete.
var Supported = []string{"en", "ja", "ko", "zh", "es"}

// Catalog is one language's text, with English behind it.
type Catalog struct {
	lang string
	text map[string]string
	en   map[string]string
}

// Load returns the catalog for lang ("ja", "ja-JP", "ja_JP.UTF-8" all mean ja), English for anything
// it has no catalog for.
func Load(lang string) *Catalog {
	code := Normalize(lang)
	en := read("en")
	if code == "en" {
		return &Catalog{lang: "en", text: en, en: en}
	}
	return &Catalog{lang: code, text: read(code), en: en}
}

// Lang is the language this catalog speaks.
func (c *Catalog) Lang() string { return c.lang }

// T is the text for key, with {name} placeholders filled from vars given as name, value pairs.
// A var named n chooses the plural form when the key has one (key.one / key.other). A key missing
// from this language reads in English; one missing everywhere reads as the key itself, which a
// guard test keeps from ever shipping.
func (c *Catalog) T(key string, vars ...any) string {
	values := map[string]string{}
	for i := 0; i+1 < len(vars); i += 2 {
		values[fmt.Sprint(vars[i])] = fmt.Sprint(vars[i+1])
	}
	text, ok := c.lookup(key, values)
	if !ok {
		return key
	}
	for name, value := range values {
		text = strings.ReplaceAll(text, "{"+name+"}", value)
	}
	return text
}

func (c *Catalog) lookup(key string, values map[string]string) (string, bool) {
	if n, ok := values["n"]; ok {
		form := key + "." + pluralForm(c.lang, n)
		if text, ok := c.text[form]; ok {
			return text, true
		}
		if text, ok := c.text[key+".other"]; ok {
			return text, true
		}
		if text, ok := c.en[key+"."+pluralForm("en", n)]; ok {
			return text, true
		}
	}
	if text, ok := c.text[key]; ok {
		return text, true
	}
	text, ok := c.en[key]
	return text, ok
}

// pluralForm is the CLDR category for n: Japanese, Korean and Chinese have one form; English and
// Spanish (and the European languages to come) distinguish exactly one.
func pluralForm(lang, n string) string {
	switch lang {
	case "ja", "ko", "zh":
		return "other"
	}
	if n == "1" {
		return "one"
	}
	return "other"
}

// Normalize reads a setting or a locale variable as a language code: "ja_JP.UTF-8" → "ja",
// "zh-Hans" → "zh". "C", "POSIX" and anything unknown are English.
func Normalize(value string) string {
	v := strings.ToLower(strings.TrimSpace(value))
	if i := strings.IndexAny(v, ".@"); i >= 0 {
		v = v[:i]
	}
	v, _, _ = strings.Cut(strings.ReplaceAll(v, "_", "-"), "-")
	for _, code := range Supported {
		if v == code {
			return code
		}
	}
	return "en"
}

// Resolve is the language to speak: the setting when one is chosen, else the locale the
// environment names (LC_ALL, LC_MESSAGES, LANG, the order POSIX gives them), else English.
func Resolve(setting string, getenv func(string) string) string {
	if strings.TrimSpace(setting) != "" {
		return Normalize(setting)
	}
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if value := strings.TrimSpace(getenv(name)); value != "" {
			return Normalize(value)
		}
	}
	return "en"
}

// Keys are every key English defines, for the guard tests.
func Keys() []string {
	en := read("en")
	keys := make([]string, 0, len(en))
	for key := range en {
		keys = append(keys, key)
	}
	return keys
}

// Raw is one language's catalog as written, for the guard tests; nil when there is none.
func Raw(lang string) map[string]string {
	if _, err := locales.ReadFile("locales/" + lang + ".json"); err != nil {
		return nil
	}
	return read(lang)
}

func read(lang string) map[string]string {
	data, err := locales.ReadFile("locales/" + lang + ".json")
	if err != nil {
		return map[string]string{}
	}
	out := map[string]string{}
	if json.Unmarshal(data, &out) != nil {
		return map[string]string{}
	}
	return out
}
