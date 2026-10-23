package policy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Port of core/cli/command-rules.ts.
//
// Command rules a person writes once instead of answering the same approval every day, after
// Codex's execpolicy: a rule names a command by its leading words and says `allow` (run without
// asking), `ask` (always ask, even in auto mode or under a standing approval) or `forbid` (never run;
// the reason goes back to the model).
//
// Each rule can carry examples, `match` and `not_match`, checked when the rules load; a rule whose
// examples fail is left out and named.
//
// `.archymedes/rules.json` in the project and `rules.json` in the config directory:
//
//	{ "rules": [
//	  { "prefix": ["git", "push"], "decision": "ask", "reason": "pushes are reviewed",
//	    "match": ["git push origin main"], "not_match": ["git pull"] },
//	  { "prefix": ["rm", ["-rf", "-fr"]], "decision": "forbid", "reason": "use trash-put instead" },
//	  { "prefix": ["npm", ["test", "run"]], "decision": "allow" }
//	] }
//
// A prefix element that is a list means any one of those words. A compound command (`a && b`,
// `a | b`, `a; b`) is judged part by part: forbid if any part is forbidden, ask if any part asks,
// allow only when every part is allowed.

// RuleDecision is what a command rule says.
type RuleDecision string

const (
	RuleAllow  RuleDecision = "allow"
	RuleAsk    RuleDecision = "ask"
	RuleForbid RuleDecision = "forbid"
)

// PrefixWord is one element of a rule's prefix: a single word, or (Alternatives) a list of which
// any one word matches. A one-word list stays a list, as it is written and described.
type PrefixWord struct {
	Words        []string
	Alternatives bool
}

// Word is a prefix element that is one word.
func Word(word string) PrefixWord { return PrefixWord{Words: []string{word}} }

// OneOf is a prefix element matched by any of words.
func OneOf(words ...string) PrefixWord { return PrefixWord{Words: words, Alternatives: true} }

// MarshalJSON writes the element as a rules file has it: a string, or a list of strings.
func (w PrefixWord) MarshalJSON() ([]byte, error) {
	if !w.Alternatives && len(w.Words) == 1 {
		return json.Marshal(w.Words[0])
	}
	return json.Marshal(w.Words)
}

// UnmarshalJSON reads a string or a list of strings.
func (w *PrefixWord) UnmarshalJSON(data []byte) error {
	var word string
	if err := json.Unmarshal(data, &word); err == nil {
		*w = Word(word)
		return nil
	}
	var words []string
	if err := json.Unmarshal(data, &words); err != nil {
		return err
	}
	*w = OneOf(words...)
	return nil
}

func (w PrefixWord) matches(word string) bool {
	for _, candidate := range w.Words {
		if candidate == word {
			return true
		}
	}
	return false
}

// CommandRule is one rule.
type CommandRule struct {
	Prefix   []PrefixWord `json:"prefix"`
	Decision RuleDecision `json:"decision"`
	Reason   string       `json:"reason,omitempty"`
	// Source is where the rule was written, for the messages that name it.
	Source string `json:"source"`
}

// CommandRules is what loading gives: the rules that hold, and a line per one that did not.
type CommandRules struct {
	Rules    []CommandRule
	Problems []string
}

// RuleVerdict is what the rules say about a command, and the rule that said it.
type RuleVerdict struct {
	Decision RuleDecision
	Rule     CommandRule
}

const (
	ProjectRulesFile = ".archymedes/rules.json"
	UserRulesFile    = "rules.json"
)

// ParseCommandRules reads one rules file's text; every rule that is malformed or fails its own
// examples is named in Problems.
func ParseCommandRules(text, source string) CommandRules {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return CommandRules{Problems: []string{fmt.Sprintf("%s: not valid JSON (%s)", source, err.Error())}}
	}
	object, _ := value.(map[string]any)
	list, ok := object["rules"].([]any)
	if !ok {
		return CommandRules{Problems: []string{fmt.Sprintf(`%s: expected {"rules": [...]}`, source)}}
	}
	result := CommandRules{}
	for index, entry := range list {
		where := fmt.Sprintf("%s rule %d", source, index+1)
		record, _ := entry.(map[string]any)
		prefix, valid := parsePrefix(record["prefix"])
		if !valid {
			result.Problems = append(result.Problems, where+`: "prefix" must be a non-empty list of words (or lists of alternative words)`)
			continue
		}
		decision, _ := record["decision"].(string)
		if decision != string(RuleAllow) && decision != string(RuleAsk) && decision != string(RuleForbid) {
			result.Problems = append(result.Problems, where+`: "decision" must be allow, ask or forbid`)
			continue
		}
		rule := CommandRule{Prefix: prefix, Decision: RuleDecision(decision), Source: source}
		if reason, ok := record["reason"].(string); ok && jsTrim(reason) != "" {
			rule.Reason = jsTrim(reason)
		}
		var failures []string
		for _, example := range examples(record["match"]) {
			if !ruleMatches(rule, example) {
				failures = append(failures, `should match "`+example+`" but does not`)
			}
		}
		for _, example := range examples(record["not_match"]) {
			if ruleMatches(rule, example) {
				failures = append(failures, `should not match "`+example+`" but does`)
			}
		}
		if len(failures) > 0 {
			result.Problems = append(result.Problems, fmt.Sprintf("%s (%s): %s — left out", where, describePrefix(rule.Prefix), strings.Join(failures, "; ")))
			continue
		}
		result.Rules = append(result.Rules, rule)
	}
	return result
}

func parsePrefix(value any) ([]PrefixWord, bool) {
	list, ok := value.([]any)
	if !ok || len(list) == 0 {
		return nil, false
	}
	prefix := make([]PrefixWord, 0, len(list))
	for _, item := range list {
		switch word := item.(type) {
		case string:
			if word == "" {
				return nil, false
			}
			prefix = append(prefix, Word(word))
		case []any:
			if len(word) == 0 {
				return nil, false
			}
			alternatives := make([]string, 0, len(word))
			for _, alternative := range word {
				text, ok := alternative.(string)
				if !ok || text == "" {
					return nil, false
				}
				alternatives = append(alternatives, text)
			}
			prefix = append(prefix, OneOf(alternatives...))
		default:
			return nil, false
		}
	}
	return prefix, true
}

// LoadCommandRules reads the project's rules (root/.archymedes/rules.json), then the person's own
// (configDir/rules.json); problems from both. A missing file is no rules. configDir is the Friday
// config directory, as ConfigDirectory gives it.
func LoadCommandRules(root, configDir string) CommandRules {
	files := []string{filepath.Join(root, filepath.FromSlash(ProjectRulesFile)), filepath.Join(configDir, UserRulesFile)}
	result := CommandRules{}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				result.Problems = append(result.Problems, fmt.Sprintf("%s: %s", file, err.Error()))
			}
			continue
		}
		loaded := ParseCommandRules(string(data), file)
		result.Rules = append(result.Rules, loaded.Rules...)
		result.Problems = append(result.Problems, loaded.Problems...)
	}
	return result
}

// ConfigDirectory is archymedesConfigDirectory from core/cli/memory.ts: ARCHYMEDES_CONFIG_DIR, else
// %APPDATA%\Archymedes on Windows, ~/Library/Application Support/Archymedes on macOS, and
// $XDG_CONFIG_HOME/archymedes (or ~/.config/archymedes) elsewhere. goos is runtime.GOOS.
func ConfigDirectory(getenv func(string) string, goos string) string {
	if dir := strings.TrimSpace(getenv("ARCHYMEDES_CONFIG_DIR")); dir != "" {
		if abs, err := filepath.Abs(getenv("ARCHYMEDES_CONFIG_DIR")); err == nil {
			return abs
		}
		return dir
	}
	home, _ := os.UserHomeDir()
	if isWindows(goos) {
		base := strings.TrimSpace(getenv("APPDATA"))
		if base == "" {
			base = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(base, "Archymedes")
	}
	if goos == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Archymedes")
	}
	base := strings.TrimSpace(getenv("XDG_CONFIG_HOME"))
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "archymedes")
}

// JudgeCommand is what the rules say about a command, or nil when no rule speaks to it (the usual
// approval applies).
func JudgeCommand(rules []CommandRule, command string) *RuleVerdict {
	if len(rules) == 0 {
		return nil
	}
	parts := SplitCompound(command)
	verdicts := make([]*RuleVerdict, len(parts))
	for index, part := range parts {
		verdicts[index] = firstMatch(rules, part)
	}
	for _, verdict := range verdicts {
		if verdict != nil && verdict.Decision == RuleForbid {
			return verdict
		}
	}
	for _, verdict := range verdicts {
		if verdict != nil && verdict.Decision == RuleAsk {
			return verdict
		}
	}
	if len(verdicts) == 0 {
		return nil
	}
	for _, verdict := range verdicts {
		if verdict == nil || verdict.Decision != RuleAllow {
			return nil
		}
	}
	return verdicts[0]
}

// ForbiddenMessage is what the model gets for a forbidden command.
func ForbiddenMessage(command string, verdict RuleVerdict) string {
	message := fmt.Sprintf("Refused by a command rule (%s, in %s): '%s' is not run here.", describePrefix(verdict.Rule.Prefix), verdict.Rule.Source, command)
	if verdict.Rule.Reason != "" {
		message += " " + verdict.Rule.Reason
	}
	return message
}

func firstMatch(rules []CommandRule, part string) *RuleVerdict {
	for _, rule := range rules {
		if ruleMatches(rule, part) {
			return &RuleVerdict{Decision: rule.Decision, Rule: rule}
		}
	}
	return nil
}

func ruleMatches(rule CommandRule, command string) bool {
	words, err := TokenizeCommand(command, "linux")
	if err != nil {
		return false
	}
	// `FOO=1 make` is `make` with an environment.
	for len(words) > 0 && envAssignment.MatchString(words[0]) {
		words = words[1:]
	}
	if len(words) < len(rule.Prefix) {
		return false
	}
	for index, expected := range rule.Prefix {
		word := words[index]
		if index == 0 {
			word = posixBasename(word)
		}
		if !expected.matches(word) {
			return false
		}
	}
	return true
}

// posixBasename is Node's path.posix.basename: trailing slashes ignored, "" for "/".
func posixBasename(p string) string {
	p = strings.TrimRight(p, "/")
	if slash := strings.LastIndexByte(p, '/'); slash >= 0 {
		return p[slash+1:]
	}
	return p
}

// SplitCompound splits a command on `&&`, `||`, `;`, `|` and newlines outside quotes.
func SplitCompound(command string) []string {
	var parts []string
	var current strings.Builder
	var quote byte
	for index := 0; index < len(command); index++ {
		character := command[index]
		if quote != 0 {
			if character == quote {
				quote = 0
			}
			current.WriteByte(character)
			continue
		}
		if character == '\'' || character == '"' {
			quote = character
			current.WriteByte(character)
			continue
		}
		if character == '\\' && index+1 < len(command) {
			// The escaped character may be several bytes; copying one byte here and the rest as plain
			// characters below is the same text, since no continuation byte is an operator.
			current.WriteByte(character)
			current.WriteByte(command[index+1])
			index++
			continue
		}
		if index+1 < len(command) {
			two := command[index : index+2]
			if two == "&&" || two == "||" {
				parts = append(parts, current.String())
				current.Reset()
				index++
				continue
			}
		}
		if character == ';' || character == '|' || character == '\n' {
			parts = append(parts, current.String())
			current.Reset()
			continue
		}
		current.WriteByte(character)
	}
	parts = append(parts, current.String())
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := jsTrim(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func examples(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, example := range list {
		switch item := example.(type) {
		case string:
			out = append(out, item)
		case []any:
			words := make([]string, 0, len(item))
			allStrings := true
			for _, word := range item {
				text, ok := word.(string)
				if !ok {
					allStrings = false
					break
				}
				words = append(words, text)
			}
			if allStrings {
				out = append(out, strings.Join(words, " "))
			}
		}
	}
	return out
}

func describePrefix(prefix []PrefixWord) string {
	words := make([]string, len(prefix))
	for index, word := range prefix {
		if word.Alternatives || len(word.Words) != 1 {
			words[index] = "{" + strings.Join(word.Words, "|") + "}"
		} else {
			words[index] = word.Words[0]
		}
	}
	return strings.Join(words, " ")
}
