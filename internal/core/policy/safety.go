package policy

import (
	"strings"
	"unicode/utf8"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Port of core/cli/safety.ts.

// Sensitive categories.
const (
	CategoryCredentials = "credentials"
	CategoryDestructive = "destructive"
	CategoryExternal    = "external"
	CategoryFinancial   = "financial"
	CategoryPrivacy     = "privacy"
	CategoryProduction  = "production"
	CategorySecurity    = "security"
)

// Safety is the screen's finding: whether a human must decide, and why.
type Safety struct {
	Sensitive  bool     `json:"sensitive"`
	Categories []string `json:"categories"`
	Reasons    []string `json:"reasons"`
}

type safetyRule struct {
	category string
	reason   string
	match    func(string) bool
}

func regexRule(category, reason, pattern string) safetyRule {
	re := jsRegexp(pattern, true)
	return safetyRule{category: category, reason: reason, match: re.MatchString}
}

// The task destructive rule in TypeScript is one regular expression,
//
//	/(?:(?<!git\s)\brm\s+[^\n]*(?:-[^\n]*[rf]\b|--recursive|--force)|\bfind\s+[^\n]*-delete\b|\b(?:delete|…)\b.{0,45}\b(?:all|…)\b)/i
//
// RE2 has no lookbehind, so the `rm` branch is matched by taskRemovalMatch below and the other two
// branches stay a regular expression; the rule matches when either does.
var (
	removalTail      = jsRegexp(`^rm\s+[^\n]*(?:-[^\n]*[rf]\b|--recursive|--force)`, true)
	destructiveOther = jsRegexp(`\bfind\s+[^\n]*-delete\b|\b(?:delete|drop|erase|purge|truncate|wipe|destroy|reset)\b.{0,45}\b(?:all|database|table|records?|history|account|branch|repository|production|live)\b`, true)
)

func isWordByte(c byte) bool {
	return c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// taskRemovalMatch is `(?<!git\s)\brm\s+[^\n]*(?:-[^\n]*[rf]\b|--recursive|--force)` with the i flag:
// some position p where `rm` starts at a word boundary, the text before p does not end in `git`
// followed by one whitespace character, and the rest of the pattern matches from p.
func taskRemovalMatch(text string) bool {
	for p := 0; p+1 < len(text); p++ {
		if (text[p] != 'r' && text[p] != 'R') || (text[p+1] != 'm' && text[p+1] != 'M') {
			continue
		}
		if p > 0 && isWordByte(text[p-1]) {
			continue // no \b before rm
		}
		if precededByGitSpace(text[:p]) {
			continue
		}
		// Slicing keeps every boundary after p correct: the text after p is unchanged.
		if removalTail.MatchString(text[p:]) {
			return true
		}
	}
	return false
}

// precededByGitSpace reports whether before ends in `git` (any case) and one whitespace character.
func precededByGitSpace(before string) bool {
	space, size := utf8.DecodeLastRuneInString(before)
	if size == 0 || !isJSSpace(space) {
		return false
	}
	rest := before[:len(before)-size]
	return len(rest) >= 3 && strings.EqualFold(rest[len(rest)-3:], "git")
}

var taskRules = []safetyRule{
	// Possessing a credential is not itself a dangerous action; disclosure and lifecycle changes are.
	regexRule(CategoryCredentials, "credential disclosure or high-impact credential change", `\b(?:export|expose|reveal|print|show|share|send|upload|publish|rotate|revoke)\b.{0,60}\b(?:api[ _-]?key|api[ _-]?token|access[ _-]?token|auth[ _-]?token|password|private[ _-]?key|secret|credential)s?\b|\b(?:set|add|store|save|replace)\b.{0,45}\b(?:production|prod|live)\b.{0,45}\b(?:api[ _-]?key|api[ _-]?token|access[ _-]?token|auth[ _-]?token|password|private[ _-]?key|secret|credential)s?\b`),
	// `git rm` is excluded: it removes a tracked file, recoverable from history.
	{category: CategoryDestructive, reason: "destructive data or repository operation", match: func(text string) bool {
		return taskRemovalMatch(text) || destructiveOther.MatchString(text)
	}},
	regexRule(CategoryProduction, "production deployment or release", `\b(?:deploy|publish|release|promote|roll\s*out|push)\b.{0,45}\b(?:production|prod|live|registry|npm|pypi|app store|play store)\b|\b(?:npm|pnpm|yarn)\s+publish\b`),
	regexRule(CategoryFinancial, "financial transaction", `\b(?:charge|refund|transfer|withdraw|purchase|pay|payout)\b.{0,45}\b(?:money|funds?|card|customer|account|invoice|payment|subscription|\$|usd|eur|gbp)\b`),
	regexRule(CategoryExternal, "external communication or publication", `\b(?:send|email|message|post|publish|submit|merge)\b.{0,45}\b(?:customer|user|client|public|email|message|notification|pull request|social|production)\b`),
	regexRule(CategoryPrivacy, "private or regulated personal data", `\b(?:download|export|share|send|upload|expose|list)\b.{0,45}\b(?:pii|personal data|patient|medical|health record|customer data|user data|social security|passport)\b`),
	regexRule(CategorySecurity, "security or access-control weakening", `\b(?:bypass|disable|remove|weaken|turn off|skip)\b.{0,45}\b(?:auth|authentication|authorization|approval|permission|mfa|2fa|security|encryption|guard|verification)\b`),
}

var commandSafetyRules = []safetyRule{
	// `rm` is deliberately absent: IsRecursiveForceRemoval checks the program actually run.
	regexRule(CategoryDestructive, "destructive shell command", `\b(?:git\s+(?:reset\s+--hard|clean\s+-[^\n]*f)|drop\s+(?:database|table)|truncate\s+table|kubectl\s+delete|terraform\s+destroy)\b`),
	// Local reads are intentionally absent; mutation and likely exfiltration remain decisions.
	regexRule(CategoryCredentials, "command changes or transmits credentials", `\b(?:secret|secrets)\s+(?:set|put|create|delete)|\b(?:set|export)\s+[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=|\b(?:curl|wget|scp|rsync|nc|netcat|gh\s+gist\s+create)\b[^\n]*(?:\.env(?:\.[^\s]+)?|credentials?|secrets?|\.pem|id_rsa)`),
	regexRule(CategoryProduction, "deployment or package publication command", `\b(?:npm|pnpm|yarn|bun|uv|poetry|twine|cargo)\s+(?:publish|release)\b|\b(?:vercel(?:\s+deploy)?\s+--prod|(?:fly|railway|render|netlify|firebase)\s+(?:deploy|up|release))|\bkubectl\s+(?:apply|replace|patch|rollout)|\bterraform\s+apply\b|\bgit\s+push\b`),
	regexRule(CategoryExternal, "network mutation or external publication", `\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|\bgh\s+pr\s+(?:create|merge|close)|\bgh\s+release\s+create\b`),
	regexRule(CategorySecurity, "privilege or permission change", `(?:^|[;&|]\s*)sudo\b|\bchmod\s+(?:-R\s+)?777\b|\b(?:disable|bypass)[-_ ]?(?:auth|security)\b`),
}

var (
	sensitivePath  = jsRegexp(`(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.gnupg|credentials?(?:\.[^/\\]+)?|secrets?(?:\.[^/\\]+)?|id_(?:rsa|ed25519)|[^/\\]*\.pem)$`, true)
	productionPath = jsRegexp(`(?:^|[/\\])(?:production|prod)(?:\.[^/\\]+|[/\\]|$)|(?:^|[/\\])(?:vercel|fly|railway|netlify)\.json$`, true)
	secretContent  = jsRegexp(`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,}`, true)
)

type finding struct{ category, reason string }

func summarize(findings []finding) Safety {
	safety := Safety{Sensitive: len(findings) > 0, Categories: []string{}, Reasons: []string{}}
	seenCategory, seenReason := map[string]bool{}, map[string]bool{}
	for _, item := range findings {
		if !seenCategory[item.category] {
			seenCategory[item.category] = true
			safety.Categories = append(safety.Categories, item.category)
		}
		if !seenReason[item.reason] {
			seenReason[item.reason] = true
			safety.Reasons = append(safety.Reasons, item.reason)
		}
	}
	return safety
}

func assess(text string, rules []safetyRule) []finding {
	var findings []finding
	for _, rule := range rules {
		if rule.match(text) {
			findings = append(findings, finding{rule.category, rule.reason})
		}
	}
	return findings
}

// AssessTaskSafety screens a user objective before a model sees it or a tool can be proposed.
func AssessTaskSafety(objective string) Safety {
	return summarize(assess(objective, taskRules))
}

// AssessToolSafety screens the exact tool and arguments before auto mode may take its workspace
// fast path.
func AssessToolSafety(call tool.Call, t *tool.Tool) Safety {
	args := call.Args
	var findings []finding
	add := func(category, reason string) { findings = append(findings, finding{category, reason}) }

	if t.Effect == tool.EffectExternal {
		add(CategoryExternal, "action affects a system outside the workspace")
	}

	command := tool.StringArg(args, "command")
	findings = append(findings, assess(command, commandSafetyRules)...)
	// Checked by token, not pattern, so flag order and spelling cannot matter.
	if IsRecursiveForceRemoval(command) {
		add(CategoryDestructive, "recursive, forced file removal")
	}
	if IsFindDelete(command) {
		add(CategoryDestructive, "find with -delete, as thorough a wipe as rm -rf")
	}

	path := tool.StringArg(args, "path")
	if sensitivePath.MatchString(path) {
		add(CategoryCredentials, "sensitive credential or environment file")
	}
	if productionPath.MatchString(path) {
		add(CategoryProduction, "production configuration file")
	}

	var content []string
	for _, name := range []string{"content", "replacement", "newText"} {
		if value, ok := args[name].(string); ok {
			content = append(content, value)
		}
	}
	if secretContent.MatchString(strings.Join(content, "\n")) {
		add(CategoryCredentials, "content appears to contain a credential or private key")
	}
	return summarize(findings)
}
