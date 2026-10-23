package policy

import (
	"runtime"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Ports of classifyVerification and its helpers from core/cli/tools.ts: what a shell command proves
// when it passes.

var (
	// testCommand names runners whose names embed a word boundary the bare word "test" cannot match.
	testCommand  = jsRegexp(`\b(tests?|pytest|jest|vitest|mocha|jasmine|karma|ava|rspec|minitest|phpunit|pest|junit|gotestsum|nose2|unittest|testthat|ctest|gradlew?\s+test|xctest)\b`, true)
	checkCommand = jsRegexp(`\b(typecheck|tsc|lint|eslint|pylint|ruff|flake8|mypy|pyright|check|build|compile|py_compile|vet|clippy|rubocop|audit|fmt|format)\b`, true)
	// behaviorCommand: suites that assemble the program. Matched before testCommand, because each also
	// contains "test" or a runner name.
	behaviorCommand = jsRegexp(`\b(e2e|end-to-end|playwright|cypress|puppeteer|selenium|webdriver|testcafe|nightwatch|integration|behave|cucumber|supertest|testcontainers)\b`, true)
	// smokeCommand: exercising the assembled thing directly, without a suite around it.
	smokeCommand = jsRegexp(`\b(smoke|healthcheck|health[-_ ]?check|curl|wget|httpie|\bhttp\s+(?:get|post)\b|playwright\s+screenshot)\b`, true)
	// persistentCommand: commands that normally stay alive until somebody stops them.
	persistentCommand = jsRegexp(`(?:^|(?:&&|;|\|)\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)(?:\s|$)|(?:vite|next\s+dev|webpack\s+serve)(?:\s|$)|bun\s+run\s+--hot\b)|(?:^|\s)--watch(?:\s|$)|\b(?:tsc|vitest|mocha|tailwindcss|webpack|rollup|nodemon|tsup|swc)\b[^|;&\n]*\s-w(?:\s|$)`, true)

	cdHead            = jsRegexp(`^\s*cd`, false)
	timeoutBoundary   = jsRegexp(`(?:^|\s)(?:timeout|gtimeout)\s+\d`, true)
	backgrounded      = jsRegexp(`(?:^|\s)&(?:\s|$)`, false)
	probed            = jsRegexp(`\b(?:curl|wget|httpie|healthcheck|health[-_ ]?check)\b`, true)
	cleaned           = jsRegexp(`\b(?:kill|pkill|trap)\b`, true)
	onlyPrints        = jsRegexp(`^\s*(?:echo|printf)\b`, true)
	noRealWork        = jsRegexp(`\b(?:no (?:automated )?tests?(?: found| configured| available)?|0 tests? (?:run|executed|passed)|no build step (?:needed|required|configured)|nothing to (?:test|build|check))\b`, true)
	scriptInterpreter = jsRegexp(`^(?:python[\d.]*|py|node|bun|deno|tsx|ts-node|ruby|php|perl|bash|sh|zsh|lua|Rscript)$`, false)
	inlineAssertion   = jsRegexp(`\bassert\b|console\.assert|assert\.(?:equal|strictEqual|deepEqual|ok)\b`, false)
)

// stripCDPrefix removes one leading `cd <dir> &&`. The JavaScript is
//
//	/^\s*cd\s+(?:[^&\n|;]|\&(?!\&))+&&\s*/
//
// whose lookahead RE2 lacks. What it matches: after `cd`, at least one whitespace character, then a
// non-empty run with no newline, `|` or `;` up to the first `&&` (a `&` followed by `&` cannot be
// in the run, so the run always ends at the first `&&`), then the `&&` and any whitespace. The
// leading `\s+` may give characters back to the run, so the run is chosen as short as possible.
func stripCDPrefix(command string) (string, bool) {
	head := cdHead.FindStringIndex(command)
	if head == nil {
		return command, false
	}
	after := head[1]
	rel := strings.Index(command[after:], "&&")
	if rel < 0 {
		return command, false
	}
	amp := after + rel
	// The whitespace the `\s+` can take.
	spaceEnd := after
	for spaceEnd < amp {
		r := []rune(command[spaceEnd:])[0]
		if !isJSSpace(r) {
			break
		}
		spaceEnd += len(string(r))
	}
	if spaceEnd == after {
		return command, false // `\s+` needs one
	}
	runStart := spaceEnd
	if runStart >= amp {
		// All whitespace up to `&&`: the run is the last whitespace character.
		runes := []rune(command[after:amp])
		if len(runes) < 2 {
			return command, false // `\s+` and the run need one character each
		}
		runStart = amp - len(string(runes[len(runes)-1]))
	}
	if strings.ContainsAny(command[runStart:amp], "\n|;") {
		return command, false
	}
	end := amp + 2
	for end < len(command) {
		r := []rune(command[end:])[0]
		if !isJSSpace(r) {
			break
		}
		end += len(string(r))
	}
	return command[end:], true
}

// VerificationTarget is the part of a command that classifies: with `cd <dir> &&` prefixes peeled
// off, so a directory name like `arch-e2e` is never read as evidence.
func VerificationTarget(command string) string {
	target := command
	for {
		stripped, changed := stripCDPrefix(target)
		if !changed || stripped == target {
			return stripped
		}
		target = stripped
	}
}

// hasPersistentCommandBoundary: a persistent process is acceptable only when the same command
// proves it will be bounded.
func hasPersistentCommandBoundary(command string) bool {
	if timeoutBoundary.MatchString(command) {
		return true
	}
	return backgrounded.MatchString(command) && probed.MatchString(command) && cleaned.MatchString(command)
}

// IsLikelyPersistentCommand reports a foreground dev server or watcher, which would consume the
// whole tool timeout and every retry.
func IsLikelyPersistentCommand(command string) bool {
	return persistentCommand.MatchString(command) && !hasPersistentCommandBoundary(command)
}

// RejectedVerificationReason is why a successful command is still not evidence ("" when it is):
// it only prints, or it said it did no work.
func RejectedVerificationReason(command, stdout, stderr string) string {
	output := jsTrim(stdout + "\n" + stderr)
	if onlyPrints.MatchString(VerificationTarget(command)) {
		return "the command only prints text"
	}
	if noRealWork.MatchString(output) {
		return "the command reported that no real build or test ran"
	}
	return ""
}

func lastPathPart(token string) string {
	if slash := strings.LastIndexByte(token, '/'); slash >= 0 {
		return token[slash+1:]
	}
	return token
}

// RunsWrittenScript reports a command that is just "run this script", where the script is a file
// the agent wrote or edited (written holds their workspace-relative paths).
func RunsWrittenScript(command string, written map[string]bool) bool {
	if len(written) == 0 {
		return false
	}
	tokens, err := TokenizeCommand(VerificationTarget(command), runtime.GOOS)
	if err != nil {
		return false
	}
	if len(tokens) < 2 || !scriptInterpreter.MatchString(lastPathPart(tokens[0])) {
		return false
	}
	file := ""
	for _, token := range tokens[1:] {
		if !strings.HasPrefix(token, "-") {
			file = token
			break
		}
	}
	if file == "" {
		return false
	}
	clean := file
	for strings.HasPrefix(clean, "./") {
		clean = clean[2:]
	}
	for path, ok := range written {
		if ok && (clean == path || strings.HasSuffix(clean, "/"+path)) {
			return true
		}
	}
	return false
}

// RunsInlineAssertion reports an interpreter one-liner that asserts something: a unit test without
// a test file. Assertion-free one-liners verify nothing.
func RunsInlineAssertion(command string) bool {
	tokens, err := TokenizeCommand(VerificationTarget(command), runtime.GOOS)
	if err != nil {
		return false
	}
	if len(tokens) < 3 || !scriptInterpreter.MatchString(lastPathPart(tokens[0])) {
		return false
	}
	flag := -1
	for index, token := range tokens {
		if token == "-c" || token == "-e" || token == "--eval" {
			flag = index
			break
		}
	}
	return flag > 0 && flag+1 < len(tokens) && inlineAssertion.MatchString(tokens[flag+1])
}

// ClassifyVerification is the strongest kind of evidence a command provides, or "" when it
// verifies nothing. Strongest first: `npm run e2e` matches both "e2e" and "test".
func ClassifyVerification(command string) tool.EvidenceKind {
	target := VerificationTarget(command)
	switch {
	case behaviorCommand.MatchString(target):
		return tool.EvidenceBehavior
	case smokeCommand.MatchString(target):
		return tool.EvidenceSmoke
	case testCommand.MatchString(target):
		return tool.EvidenceTests
	case checkCommand.MatchString(target):
		return tool.EvidenceCheck
	}
	return ""
}
