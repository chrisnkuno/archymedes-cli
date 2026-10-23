package policy

import (
	"regexp"
	"strings"
)

// Port of core/cli/command-readonly.ts.

// IsReadOnlyCommand reports whether a shell command only reads. Conservative by construction: every
// part of it must be a program on the list below, used with no argument that turns it into a writer
// or a launcher. Anything it cannot account for (command substitution, an output redirect, a
// background `&`, an environment assignment, an unbalanced quote, an unknown program) is not
// read-only, and the person is asked. goos is runtime.GOOS (or Node's "win32").
func IsReadOnlyCommand(command, goos string) bool {
	text := jsTrim(command)
	if text == "" || hasUnsafeShellSyntax(text) {
		return false
	}
	parts := SplitCompound(stripHarmlessRedirects(text))
	if len(parts) == 0 {
		return false
	}
	for _, part := range parts {
		tokens, err := TokenizeCommand(part, goos)
		if err != nil || !readOnlyInvocation(tokens) {
			return false
		}
	}
	return true
}

// The JavaScript is `/(^|\s)\d?>{1,2}\s*\/dev\/null(?=\s|$)/g` and `/(^|\s)\d?>&\d(?=\s|$)/g`;
// the lookahead is checked in replaceWhereFollowed.
var (
	devNullRedirect = jsRegexp(`(^|\s)\d?>{1,2}\s*\/dev\/null`, false)
	mergeRedirect   = jsRegexp(`(^|\s)\d?>&\d`, false)
)

// stripHarmlessRedirects removes `2>/dev/null`, `>/dev/null`, `2>&1`, `>&2`: they discard or merge
// output and write no file.
func stripHarmlessRedirects(command string) string {
	return replaceWhereFollowed(mergeRedirect, replaceWhereFollowed(devNullRedirect, command))
}

// hasUnsafeShellSyntax finds shell syntax that runs or writes something the program list cannot
// see: `$(...)` and backticks, `>` (once the harmless redirects are gone), a lone `&`, `<(`/`>(`, a
// heredoc. Only outside single quotes, where the shell would act on them.
func hasUnsafeShellSyntax(command string) bool {
	stripped := stripHarmlessRedirects(command)
	var quote byte
	for index := 0; index < len(stripped); index++ {
		character := stripped[index]
		var next byte
		if index+1 < len(stripped) {
			next = stripped[index+1]
		}
		if quote == '\'' {
			if character == '\'' {
				quote = 0
			}
			continue
		}
		if character == '\\' {
			index++
			continue
		}
		if character == '`' || (character == '$' && next == '(') {
			return true
		}
		if quote == '"' {
			if character == '"' {
				quote = 0
			}
			continue
		}
		if character == '\'' || character == '"' {
			quote = character
			continue
		}
		if character == '>' {
			return true
		}
		if character == '<' && next == '(' {
			return true
		}
		if character == '<' && next == '<' {
			return true // a heredoc feeds a program text it may run
		}
		if character == '&' {
			if next == '&' {
				index++
				continue
			}
			return true
		}
	}
	return false
}

func stringSet(words ...string) map[string]bool {
	set := make(map[string]bool, len(words))
	for _, word := range words {
		set[word] = true
	}
	return set
}

// readers only read or print, whatever their arguments (barring writerFlags).
var readers = stringSet(
	"ls", "dir", "cat", "head", "nl", "wc", "pwd", "echo", "printf", "which", "where", "whereis", "file", "stat",
	"du", "df", "tree", "cut", "tr", "basename", "dirname", "realpath", "readlink", "grep", "egrep", "fgrep",
	"rg", "diff", "cmp", "comm", "true", "false", "date", "uname", "whoami", "id", "printenv", "hostname",
	"jq", "column", "md5sum", "sha1sum", "sha256sum", "sha512sum", "shasum", "cksum", "od", "hexdump",
	"strings", "seq", "test", "[", "type", "findstr", "uniq", "sort", "tail", "cd",
)

// writerFlags make an otherwise reading program write, follow forever, or run something.
var writerFlags = map[string]*regexp.Regexp{
	"sort": jsRegexp(`^(-o|--output)`, false),
	"tail": jsRegexp(`^(-[a-zA-Z]*[fF]|--follow)`, false),
	"rg":   jsRegexp(`^(--pre|--pre-glob)\b`, false),
	"date": jsRegexp(`^(-s|--set)`, false),
}

// toolchains answer a version or help query by printing and exiting. Not arbitrary programs:
// `./x --version` runs x.
var toolchains = stringSet(
	"node", "npm", "npx", "bun", "deno", "pnpm", "yarn", "python", "python3", "pip", "pip3", "uv", "go", "cargo",
	"rustc", "rustup", "java", "javac", "ruby", "gem", "php", "tsc", "git", "docker", "kubectl", "make", "gcc", "clang",
)

// gitReaders are git subcommands that only read the repository; some carry a check in gitReadOnly.
var gitReaders = stringSet(
	"status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe",
	"remote", "tag", "shortlog", "cat-file", "merge-base", "config", "stash", "reflog", "whatchanged",
	"for-each-ref", "name-rev", "count-objects", "worktree", "rev-list", "show-ref", "check-ignore", "help", "version",
)

var (
	envAssignment  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	versionQuery   = regexp.MustCompile(`^(--version|-v|-V|version|--help|-h)$`)
	hostnameWriter = regexp.MustCompile(`^(-F|--file|-b|--boot)`)
	findActions    = regexp.MustCompile(`^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$`)
	sedInPlace     = regexp.MustCompile(`^(-i|--in-place|-[a-zA-Z]*i)`)
	sedPrintScript = jsRegexp(`^[\d,$\s;p]+$`, false)
	gitWriterArg   = regexp.MustCompile(`^(--output|--ext-diff|--textconv|--exec|-o$)`)
	gitBranchWrite = regexp.MustCompile(`^(-[dDmMcC]|--delete|--move|--copy|--set-upstream|--unset-upstream|--edit-description|-u$|--track|-f$|--force)`)
	gitTagWrite    = regexp.MustCompile(`^(-[dafsmFu]$|--delete|--annotate|--sign|--force|--message|--file)`)
	gitConfigRead  = regexp.MustCompile(`^(--get|--get-all|--get-regexp|--list|-l)$`)
	gitConfigWrite = regexp.MustCompile(`^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e)$`)
)

func anyMatch(args []string, re *regexp.Regexp) bool {
	for _, arg := range args {
		if re.MatchString(arg) {
			return true
		}
	}
	return false
}

func positionals(args []string) []string {
	var out []string
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			out = append(out, arg)
		}
	}
	return out
}

func readOnlyInvocation(tokens []string) bool {
	if len(tokens) == 0 || tokens[0] == "" || envAssignment.MatchString(tokens[0]) {
		return false // `FOO=1 cmd` changes what cmd does
	}
	program, args := tokens[0], tokens[1:]
	name := strings.ToLower(program)
	if toolchains[name] && len(args) == 1 && versionQuery.MatchString(args[0]) {
		return true
	}
	switch name {
	case "git":
		return gitReadOnly(args)
	case "find":
		return !anyMatch(args, findActions)
	case "sed":
		return sedReadOnly(args)
	case "env", "printenv":
		return name == "printenv" || len(args) == 0
	case "command":
		return len(args) > 0 && (args[0] == "-v" || args[0] == "-V")
	}
	if !readers[name] {
		return false
	}
	// `uniq in out` writes `out`; `hostname name` renames the machine. One positional or none only reads.
	if name == "uniq" {
		return len(positionals(args)) <= 1
	}
	if name == "hostname" {
		for _, arg := range args {
			if !strings.HasPrefix(arg, "-") || hostnameWriter.MatchString(arg) {
				return false
			}
		}
		return true
	}
	writer := writerFlags[name]
	return writer == nil || !anyMatch(args, writer)
}

// sedReadOnly accepts `sed -n '1,80p' file`: printing lines. Never `-i`, never a `w` or `e` command.
func sedReadOnly(args []string) bool {
	if anyMatch(args, sedInPlace) {
		return false
	}
	hasN := false
	for _, arg := range args {
		if arg == "-n" {
			hasN = true
		}
	}
	if !hasN {
		return false
	}
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			return sedPrintScript.MatchString(arg)
		}
	}
	return false
}

func gitReadOnly(args []string) bool {
	index := 0
	// Global options before the subcommand. `-c` is refused: `-c diff.external=…` runs a program.
	for index < len(args) && strings.HasPrefix(args[index], "-") {
		option := args[index]
		if option == "-C" {
			index += 2
			continue
		}
		if option == "--no-pager" || option == "--no-optional-locks" || option == "-P" {
			index++
			continue
		}
		return false
	}
	if index >= len(args) || args[index] == "" || !gitReaders[args[index]] {
		return false
	}
	subcommand := args[index]
	rest := args[index+1:]
	// Writing to a file, or handing output to a program, from any reading subcommand.
	if anyMatch(rest, gitWriterArg) {
		return false
	}
	positional := positionals(rest)
	first := ""
	if len(positional) > 0 {
		first = positional[0]
	}
	switch subcommand {
	// Listing only: a name creates a branch or tag, and these flags rename, delete or move.
	case "branch":
		return len(positional) == 0 && !anyMatch(rest, gitBranchWrite)
	case "tag":
		listing := false
		for _, arg := range rest {
			if arg == "-l" || arg == "--list" {
				listing = true
			}
		}
		return (len(positional) == 0 || listing) && !anyMatch(rest, gitTagWrite)
	case "remote":
		return len(positional) == 0 || first == "show" || first == "get-url"
	case "config":
		return anyMatch(rest, gitConfigRead) && !anyMatch(rest, gitConfigWrite)
	case "stash":
		return first == "list" || first == "show"
	case "reflog":
		return len(positional) == 0 || first == "show"
	case "worktree":
		return first == "list"
	default:
		return true
	}
}
