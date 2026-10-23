package conform

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Documentation rules: the same precision as the mechanisms, for the pages that describe them.
// A document has one title and a sentence under it saying what it is for; headings descend one
// level at a time; a long page lists its sections; every table row has its header's columns;
// sentences are at most MaxSentenceWords long; filler words and the vocabulary's "not" words are
// absent; keys are written as pressed.

// MaxSentenceWords is the longest sentence a document may have.
const MaxSentenceWords = 40

// ContentsAfter is how many second-level sections make a page long enough to list them.
const ContentsAfter = 6

// filler are words that add length and no meaning.
var filler = regexp.MustCompile(`(?i)\b(simply|just|easily|obviously|basically|clearly|really|very|quite|various|in order to|note that|please|etc\.?|and so on|TODO|TBD)\b`)

// unwords are the vocabulary's "not" words: each thing has one name (docs/mechanisms §2).
var unwords = regexp.MustCompile(`\b(LLMs?|backends?|permission prompts?|child agents?|vendors?)\b`)

// keyCase finds a key written in capitals: keys are written as pressed (esc, ctrl+c, shift+tab).
var keyCase = regexp.MustCompile(`\b(Esc|Ctrl\+|Alt\+|Shift\+|Cmd\+|CTRL|ESC)`)

// codeSpan is inline code, which is quoted, not prose.
var codeSpan = regexp.MustCompile("`[^`]*`")

// links are inline links; their text is prose, their target is not.
var linkTarget = regexp.MustCompile(`\]\([^)]*\)`)

// DocLines is the document split into its prose lines, its headings and its table rows, with
// fenced code left out.
type DocLines struct {
	Headings []Heading
	Prose    []string // paragraphs and list items, with inline code and link targets removed
	Tables   [][]string
	Raw      string // the document without fenced code
}

// Heading is one heading: its level and text.
type Heading struct {
	Level int
	Text  string
}

// ParseDoc splits a Markdown document into what the rules look at.
func ParseDoc(text string) DocLines {
	var d DocLines
	var raw strings.Builder
	inFence, paragraph := false, false
	var table []string
	flush := func() {
		if len(table) > 0 {
			d.Tables = append(d.Tables, table)
			table = nil
		}
	}
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inFence, paragraph = !inFence, false
			flush()
			continue
		}
		if inFence {
			continue
		}
		raw.WriteString(line + "\n")
		switch {
		case strings.HasPrefix(trimmed, "|"):
			table, paragraph = append(table, trimmed), false
			continue
		case strings.HasPrefix(trimmed, "#"):
			flush()
			paragraph = false
			level := len(trimmed) - len(strings.TrimLeft(trimmed, "#"))
			d.Headings = append(d.Headings, Heading{level, strings.TrimSpace(trimmed[level:])})
			continue
		}
		flush()
		// A paragraph wraps over lines; a blank line, a list item or a quote starts the next.
		if trimmed == "" {
			paragraph = false
			continue
		}
		prose := plain(trimmed)
		item := listItem.MatchString(trimmed) || strings.HasPrefix(trimmed, ">")
		if paragraph && !item {
			d.Prose[len(d.Prose)-1] += " " + prose
		} else {
			d.Prose = append(d.Prose, prose)
		}
		paragraph = true
	}
	flush()
	d.Raw = raw.String()
	return d
}

var listItem = regexp.MustCompile(`^([-*+]|\d+\.) `)

// plain is a line as prose: inline code and link targets taken out.
func plain(line string) string {
	return linkTarget.ReplaceAllString(codeSpan.ReplaceAllString(line, "Code"), "]")
}

// cells splits a table row into its cells, with escaped pipes and pipes inside code kept whole.
func cells(row string) []string {
	row = strings.ReplaceAll(codeSpan.ReplaceAllString(row, "code"), `\|`, "")
	parts := strings.Split(strings.Trim(row, "|"), "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

// DocStructure checks a document's shape.
func DocStructure(text string) []string {
	d := ParseDoc(text)
	var problems []string
	titles := 0
	for _, h := range d.Headings {
		if h.Level == 1 {
			titles++
		}
	}
	if titles != 1 {
		problems = append(problems, fmt.Sprintf("%d titles; a document has exactly one", titles))
	}
	if len(d.Headings) > 0 && d.Headings[0].Level != 1 {
		problems = append(problems, "the first heading is not the title")
	}
	for i := 1; i < len(d.Headings); i++ {
		if d.Headings[i].Level > d.Headings[i-1].Level+1 {
			problems = append(problems, fmt.Sprintf("heading %q skips from level %d to %d", d.Headings[i].Text, d.Headings[i-1].Level, d.Headings[i].Level))
		}
	}
	// A sentence under the title says what the document is for.
	lines := strings.Split(d.Raw, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "# ") {
			for _, next := range lines[i+1:] {
				if t := strings.TrimSpace(next); t != "" {
					if strings.HasPrefix(t, "#") || strings.HasPrefix(t, "|") || strings.HasPrefix(t, "-") {
						problems = append(problems, "no sentence under the title saying what the document is for")
					}
					break
				}
			}
			break
		}
	}
	sections := 0
	for _, h := range d.Headings {
		if h.Level == 2 {
			sections++
		}
	}
	if sections >= ContentsAfter {
		before := d.Raw
		if i := strings.Index(d.Raw, "\n## "); i >= 0 {
			before = d.Raw[:i]
		}
		if strings.Count(before, "](#") < 3 {
			problems = append(problems, fmt.Sprintf("%d sections and no list of them before the first", sections))
		}
	}
	for _, table := range d.Tables {
		want := columns(table[0])
		for _, row := range table[1:] {
			if got := columns(row); got != want {
				problems = append(problems, fmt.Sprintf("table row has %d columns, its header %d: %s", got, want, cut(row)))
			}
		}
	}
	return problems
}

// columns counts a table row's cells, not counting escaped pipes or pipes inside code.
func columns(row string) int {
	return len(cells(row))
}

// DocProse checks a document's sentences and words.
func DocProse(text string) []string {
	d := ParseDoc(text)
	var problems []string
	prose := append([]string{}, d.Prose...)
	for _, table := range d.Tables {
		// A column headed "Not" lists words that are not used: it names them on purpose.
		not := -1
		for i, h := range cells(table[0]) {
			if h == "Not" {
				not = i
			}
		}
		for _, row := range table {
			c := cells(row)
			if not >= 0 && not < len(c) {
				c[not] = ""
			}
			prose = append(prose, plain(strings.Join(c, " | ")))
		}
	}
	for _, line := range prose {
		for _, m := range filler.FindAllString(line, -1) {
			problems = append(problems, fmt.Sprintf("filler %q in: %s", m, cut(line)))
		}
		for _, m := range unwords.FindAllString(line, -1) {
			problems = append(problems, fmt.Sprintf("%q is not in the vocabulary (docs/mechanisms §2) in: %s", m, cut(line)))
		}
		for _, m := range keyCase.FindAllString(line, -1) {
			problems = append(problems, fmt.Sprintf("key written %q; keys are written as pressed (esc, ctrl+c) in: %s", m, cut(line)))
		}
	}
	for _, para := range d.Prose {
		for _, sentence := range sentences(para) {
			if n := len(strings.Fields(sentence)); n > MaxSentenceWords {
				problems = append(problems, fmt.Sprintf("a sentence of %d words (at most %d): %s", n, MaxSentenceWords, cut(sentence)))
			}
		}
	}
	return problems
}

// sentences splits prose at a full stop, question or exclamation mark followed by a space and a
// capital, so "e.g. this" and "v1.2" stay whole.
func sentences(text string) []string {
	var out []string
	start := 0
	runes := []rune(text)
	for i := 0; i < len(runes)-2; i++ {
		if (runes[i] == '.' || runes[i] == '?' || runes[i] == '!') && runes[i+1] == ' ' && (unicode.IsUpper(runes[i+2]) || runes[i+2] == '*') {
			out = append(out, string(runes[start:i+1]))
			start = i + 2
		}
	}
	return append(out, string(runes[start:]))
}

func cut(s string) string {
	if utf8.RuneCountInString(s) > 70 {
		return string([]rune(s)[:70]) + "…"
	}
	return s
}

// ProperNouns may open a Go error value, which otherwise starts in lower case.
var ProperNouns = map[string]bool{"Friday": true, "Anthropic": true, "Claude": true, "Codex": true, "OpenRouter": true, "OpenAI": true, "Groq": true, "Ollama": true, "Zed": true, "Unsplash": true, "TypeScript": true, "Go": true, "Docker": true, "E2B": true, "GitHub": true}

var identifier = regexp.MustCompile(`^[A-Z][A-Z0-9_]+$`)

// GoError checks a Go error value's text, by Go's convention: it is wrapped by its caller
// ("friday: <err>"), so it starts in lower case (unless it opens with an identifier, a proper
// noun or a value) and has no closing punctuation.
func GoError(text string) []string {
	var problems []string
	if text == "" {
		return []string{"error text is empty"}
	}
	if strings.HasSuffix(text, ".") || strings.HasSuffix(text, "!") || strings.HasSuffix(text, "\n") || strings.HasSuffix(text, ":") {
		problems = append(problems, fmt.Sprintf("error %q ends with punctuation; its caller adds what follows", text))
	}
	word := strings.FieldsFunc(text, func(r rune) bool { return r == ' ' || r == ':' || r == ',' })
	if len(word) > 0 {
		first := word[0]
		r, _ := utf8.DecodeRuneInString(first)
		if unicode.IsUpper(r) && !identifier.MatchString(first) && !ProperNouns[strings.TrimRight(first, "'s")] {
			problems = append(problems, fmt.Sprintf("error %q starts with a capital; an error value is lower case (it follows its caller's words)", text))
		}
	}
	return problems
}

// ToolText checks text a tool returns to the model: a sentence that opens with a capital, or with
// what it names written as typed (`argument`, a path, a value).
func ToolText(text string) []string {
	if text == "" {
		return []string{"tool text is empty"}
	}
	var problems []string
	r, _ := utf8.DecodeRuneInString(text)
	if !unicode.IsUpper(r) && !unicode.IsDigit(r) && !strings.ContainsRune("`%/!@$~.([", r) {
		problems = append(problems, fmt.Sprintf("tool text %q starts in lower case; name an argument as `code`", cut(text)))
	}
	lower := strings.ToLower(text)
	for _, prefix := range []string{"error:", "failed:", "fatal:"} {
		if strings.HasPrefix(lower, prefix) {
			problems = append(problems, fmt.Sprintf("tool text %q opens with %q; the result is already marked as an error", cut(text), prefix))
		}
	}
	return problems
}
