package i18n

import (
	"regexp"
	"slices"
	"testing"
)

func TestTextComesInTheChosenLanguageAndFallsBackToEnglish(t *testing.T) {
	c := &Catalog{lang: "ja", text: map[string]string{"a": "あ"}, en: map[string]string{"a": "a", "b": "b {x}"}}
	if got := c.T("a"); got != "あ" {
		t.Errorf("T(a) = %q", got)
	}
	if got := c.T("b", "x", 7); got != "b 7" {
		t.Errorf("a key missing in ja reads in English, filled: %q", got)
	}
	if got := c.T("missing"); got != "missing" {
		t.Errorf("a key missing everywhere reads as itself: %q", got)
	}
}

func TestPluralsFollowEachLanguagesRules(t *testing.T) {
	en := map[string]string{"q.one": "{n} more waiting", "q.other": "{n} more waiting (all)"}
	english := &Catalog{lang: "en", text: en, en: en}
	if english.T("q", "n", 1) != "1 more waiting" || english.T("q", "n", 3) != "3 more waiting (all)" {
		t.Errorf("en plurals: %q / %q", english.T("q", "n", 1), english.T("q", "n", 3))
	}
	japanese := &Catalog{lang: "ja", text: map[string]string{"q.other": "あと{n}件"}, en: en}
	if got := japanese.T("q", "n", 1); got != "あと1件" {
		t.Errorf("ja has one form, used for 1 too: %q", got)
	}
}

func TestTheLanguageComesFromTheSettingThenTheEnvironment(t *testing.T) {
	env := func(values map[string]string) func(string) string { return func(k string) string { return values[k] } }
	for _, c := range []struct {
		setting string
		env     map[string]string
		want    string
	}{
		{"ja", map[string]string{"LANG": "es_ES.UTF-8"}, "ja"},
		{"", map[string]string{"LANG": "ko_KR.UTF-8"}, "ko"},
		{"", map[string]string{"LC_ALL": "zh_CN.UTF-8", "LANG": "es_ES"}, "zh"},
		{"", map[string]string{"LANG": "C.UTF-8"}, "en"},
		{"", map[string]string{"LANG": "fr_FR"}, "en"}, // not offered yet
		{"zh-Hans", nil, "zh"},
	} {
		if got := Resolve(c.setting, env(c.env)); got != c.want {
			t.Errorf("Resolve(%q, %v) = %q, want %q", c.setting, c.env, got, c.want)
		}
	}
}

// The guards on the shipped catalogs: English is complete and every other language only translates
// what English has, with the same placeholders.
func TestEveryCatalogMatchesEnglish(t *testing.T) {
	en := Raw("en")
	if len(en) == 0 {
		t.Fatal("en.json is empty or missing")
	}
	placeholder := regexp.MustCompile(`\{[a-z]+\}`)
	for _, lang := range Supported[1:] {
		catalog := Raw(lang)
		if catalog == nil {
			t.Errorf("%s.json is missing", lang)
			continue
		}
		for key, text := range catalog {
			base := regexp.MustCompile(`\.(one|other)$`).ReplaceAllString(key, "")
			source, ok := en[key]
			if !ok {
				source, ok = en[base+".other"]
			}
			if !ok {
				t.Errorf("%s.json has %q, which en.json does not", lang, key)
				continue
			}
			want, got := placeholder.FindAllString(source, -1), placeholder.FindAllString(text, -1)
			slices.Sort(want)
			slices.Sort(got)
			if !slices.Equal(want, got) {
				t.Errorf("%s %q has placeholders %v, English has %v", lang, key, got, want)
			}
		}
	}
}

func TestALanguageNotOfferedYetReadsAsEnglish(t *testing.T) {
	if c := Load("fr_FR.UTF-8"); c.Lang() != "en" || c.T("chat.thinking") != "thinking…" {
		t.Errorf("fr is not offered yet: %s %q", c.Lang(), c.T("chat.thinking"))
	}
	if got := Load("ja_JP.UTF-8").T("chat.thinking"); got != "考え中…" {
		t.Errorf("ja: %q", got)
	}
}
