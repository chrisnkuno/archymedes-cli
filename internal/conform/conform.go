// Package conform is the mechanism design system's rules, as code: what a name, a help line, a
// message, an argument hint or a tool description must look like, measured exactly. Every
// registry in the CLI (slash commands, key actions, tools, roles, protocol methods, flags,
// settings) is checked against these by a TestConform… test beside it, and `bun run recheck` runs
// every one of them. The standard they implement is docs/mechanisms/README.md.
//
// Each check returns the problems it found, as sentences; none means it conforms. Tolerance is
// zero: there is no baseline of excused problems.
package conform

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Measures. A help line fits one row of the command list beside its name and hint at 120 columns;
// a message fits a toast; a label fits the dock and the Keys app.
const (
	MaxHelp            = 100
	MaxMessage         = 120
	MaxLabel           = 24
	MaxToolDescription = 400
	MaxRoleDescription = 100
)

// Name grammars, one per kind of mechanism.
var names = map[string]*regexp.Regexp{
	"command": regexp.MustCompile(`^[a-z][a-z0-9-]{0,19}$`),                      // /goal-check
	"action":  regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`),               // next-window
	"tool":    regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`),               // read_file
	"role":    regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`),                      // explore
	"flag":    regexp.MustCompile(`^(--[a-z][a-z0-9]*(-[a-z0-9]+)*|-[a-zA-Z])$`), // --no-mouse, -p
	"method":  regexp.MustCompile(`^(initialize|authenticate|session/[a-z_]+|_archymedes/[a-z_-]+(/[a-z_-]+)*)$`),
	"setting": regexp.MustCompile(`^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$`), // ARCHYMEDES_ENGINE, GROQ_API_KEY
	"event":   regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`), // tool_result
}

// Name checks a name against its kind's grammar.
func Name(kind, name string) []string {
	re, ok := names[kind]
	if !ok {
		return []string{fmt.Sprintf("no grammar for names of kind %q", kind)}
	}
	if !re.MatchString(name) {
		return []string{fmt.Sprintf("%s name %q does not match %s", kind, name, re)}
	}
	return nil
}

// backReferences are phrasings that only make sense beside another row: a line must stand alone.
var backReferences = []string{"the same", "same as above", "as above", "see above", "ditto", "likewise"}

// shout is a word in capitals that is not a known initialism.
var shout = regexp.MustCompile(`\b[A-Z]{4,}\b`)

// initialisms may be written in capitals.
var initialisms = map[string]bool{"HTTP": true, "HTTPS": true, "JSON": true, "YAML": true, "ANSI": true, "UTF": true, "SIGINT": true, "GOOS": true, "README": true, "TODO": true, "FIXME": true, "PATH": true, "HEAD": true, "FETCH": true, "HOME": true, "EDITOR": true, "VISUAL": true, "ARGUMENTS": true}

// line is what every line a person reads shares: no padding, no doubled spaces, no trailing full
// stop, no shouting, no back-references, within its length.
func line(what, text string, max int) []string {
	var problems []string
	if strings.TrimSpace(text) == "" {
		return []string{what + " is empty"}
	}
	if text != strings.TrimSpace(text) {
		problems = append(problems, fmt.Sprintf("%s %q has leading or trailing space", what, text))
	}
	if strings.Contains(text, "  ") {
		problems = append(problems, fmt.Sprintf("%s %q has a doubled space", what, text))
	}
	if n := utf8.RuneCountInString(text); n > max {
		problems = append(problems, fmt.Sprintf("%s %q is %d characters; at most %d", what, text, n, max))
	}
	if strings.HasSuffix(text, ".") && !strings.HasSuffix(text, "...") {
		problems = append(problems, fmt.Sprintf("%s %q ends with a full stop; a line is not a paragraph", what, text))
	}
	if strings.HasSuffix(text, "!") {
		problems = append(problems, fmt.Sprintf("%s %q ends with an exclamation mark; the voice is calm", what, text))
	}
	lower := strings.ToLower(text)
	for _, ref := range backReferences {
		if strings.HasPrefix(lower, ref) || strings.Contains(lower, " "+ref+":") {
			problems = append(problems, fmt.Sprintf("%s %q refers to another row (%q); it must stand alone", what, text, ref))
		}
	}
	for _, word := range shout.FindAllString(text, -1) {
		if !initialisms[word] {
			problems = append(problems, fmt.Sprintf("%s %q shouts %q", what, text, word))
		}
	}
	for _, key := range keyCase.FindAllString(text, -1) {
		problems = append(problems, fmt.Sprintf("%s %q writes the key %q; keys are written as pressed (esc, ctrl+s)", what, text, key))
	}
	return problems
}

// writtenAsNamed are names that open in lower case by their owners' spelling.
var writtenAsNamed = []string{"xAI", "iTerm", "macOS", "npm"}

// startsUpper reports whether the first letter is a capital, or the line opens with a command,
// key or path sigil (/, !, @, $, ~, .), a digit, or a formatted value (%), which are written as
// typed.
func startsUpper(text string) bool {
	for _, name := range writtenAsNamed {
		if strings.HasPrefix(text, name) {
			return true
		}
	}
	r, _ := utf8.DecodeRuneInString(text)
	// A format opening with a value (%s) starts with whatever is put there: a name, a path.
	return unicode.IsUpper(r) || unicode.IsDigit(r) || strings.ContainsRune("/!@$~.%", r)
}

// Help checks a help line: what a command, flag or app does, said so that someone who has never
// read the docs knows what happens. It starts with a capital (or as typed), and stands alone.
func Help(text string) []string {
	problems := line("help", text, MaxHelp)
	if text != "" && !startsUpper(text) {
		problems = append(problems, fmt.Sprintf("help %q starts in lower case; a help line is a sentence", text))
	}
	return problems
}

// Message checks a message shown to a person (a toast, a notice): a sentence, calm, within a
// toast's width, never a bare error word.
func Message(text string) []string {
	problems := line("message", text, MaxMessage)
	if text != "" && !startsUpper(text) {
		problems = append(problems, fmt.Sprintf("message %q starts in lower case", text))
	}
	lower := strings.ToLower(text)
	for _, prefix := range []string{"error:", "error ", "failed:", "fatal:", "warning:", "oops"} {
		if strings.HasPrefix(lower, prefix) {
			problems = append(problems, fmt.Sprintf("message %q opens with %q; say what happened instead", text, prefix))
		}
	}
	return problems
}

// Label checks a short label (a key action in the dock, the Keys app, the help): lower-case words.
func Label(text string) []string {
	problems := line("label", text, MaxLabel)
	if text != strings.ToLower(text) {
		problems = append(problems, fmt.Sprintf("label %q is not lower case", text))
	}
	return problems
}

// RoleDescription checks a sub-agent role's description, read by the model beside the role's
// name: a lower-case phrase completing "a helper that …" or "for …".
func RoleDescription(text string) []string {
	return line("role description", text, MaxRoleDescription)
}

// ToolDescription checks a tool's description, read by the model: whole sentences, so it ends
// with a full stop; starts with a capital; within its length.
func ToolDescription(text string) []string {
	var problems []string
	if strings.TrimSpace(text) == "" {
		return []string{"tool description is empty"}
	}
	if n := utf8.RuneCountInString(text); n > MaxToolDescription {
		problems = append(problems, fmt.Sprintf("tool description is %d characters; at most %d", n, MaxToolDescription))
	}
	if !startsUpper(text) {
		problems = append(problems, fmt.Sprintf("tool description %q starts in lower case", first(text)))
	}
	if !strings.HasSuffix(text, ".") && !strings.HasSuffix(text, ".)") {
		problems = append(problems, fmt.Sprintf("tool description %q does not end a sentence", last(text)))
	}
	if strings.Contains(text, "  ") {
		problems = append(problems, "tool description has a doubled space")
	}
	return problems
}

func first(s string) string {
	if r := []rune(s); len(r) > 40 {
		return string(r[:40]) + "…"
	}
	return s
}

func last(s string) string {
	if r := []rune(s); len(r) > 40 {
		return "…" + string(r[len(r)-40:])
	}
	return s
}

// hintWord is one word of an argument hint: a placeholder or literal, lower case; a suffix such
// as `:line` (as in <path>[:line]) opens with its colon.
var hintWord = regexp.MustCompile(`^:?[a-z][a-z0-9-]*$`)

// ArgHint checks an argument hint, in the one grammar every hint uses:
//
//	[x]      x is optional          <x>   x is a placeholder, required
//	a|b      a or b                  words are lower case; groups do not nest past one level
//
// An empty hint means the command takes no argument.
func ArgHint(hint string) []string {
	if hint == "" {
		return nil
	}
	var problems []string
	depth := 0
	for _, r := range hint {
		switch r {
		case '[', '<':
			depth++
			if depth > 2 {
				problems = append(problems, fmt.Sprintf("hint %q nests deeper than two", hint))
			}
		case ']', '>':
			depth--
			if depth < 0 {
				problems = append(problems, fmt.Sprintf("hint %q closes a group it did not open", hint))
				depth = 0
			}
		}
	}
	if depth != 0 {
		problems = append(problems, fmt.Sprintf("hint %q leaves a group open", hint))
	}
	// Every word, with the grammar's punctuation taken away, is a lower-case word.
	cleaned := strings.NewReplacer("[", " ", "]", " ", "<", " ", ">", " ", "|", " ").Replace(hint)
	for _, word := range strings.Fields(cleaned) {
		if !hintWord.MatchString(word) {
			problems = append(problems, fmt.Sprintf("hint %q has %q, which is not a lower-case word", hint, word))
		}
	}
	return problems
}

// Unique reports names that appear more than once.
func Unique(kind string, list []string) []string {
	seen := map[string]bool{}
	var problems []string
	for _, n := range list {
		if seen[n] {
			problems = append(problems, fmt.Sprintf("%s %q is defined twice", kind, n))
		}
		seen[n] = true
	}
	return problems
}
