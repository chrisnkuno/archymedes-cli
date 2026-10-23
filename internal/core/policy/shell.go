package policy

import (
	"errors"
	"regexp"
	"runtime"
	"strings"
)

// Ports of core/cli/command.ts (the tokenizer and the removal checks) and isRefusedCommand from
// core/cli/tools.ts.

var (
	errUnbalancedQuote = errors.New("unbalanced quote in command")
	errEmptyCommand    = errors.New("command is empty")
)

// isWindows reports whether goos names Windows, in Go's spelling or Node's.
func isWindows(goos string) bool { return goos == "windows" || goos == "win32" }

// TokenizeCommand is minimal shell-compatible tokenization for the direct-exec fast path. goos is
// runtime.GOOS (or Node's "win32"): on Windows a backslash is a path separator, not an escape.
func TokenizeCommand(command, goos string) ([]string, error) {
	chars := []rune(command)
	var tokens []string
	var current strings.Builder
	var quote rune
	escaped := false
	hasToken := false
	windows := isWindows(goos)

	for index := 0; index < len(chars); index++ {
		character := chars[index]
		if escaped {
			current.WriteRune(character)
			escaped = false
			hasToken = true
			continue
		}
		// A Windows backslash is normally a path separator, not a Unix escape. Shell syntax takes the
		// platform shell path; direct argv execution must preserve `C:\\Users\\...` exactly.
		if character == '\\' && quote != '\'' && !windows {
			var next rune = -1
			if index+1 < len(chars) {
				next = chars[index+1]
			}
			// Inside double quotes, POSIX only removes a backslash before these characters.
			if quote == '"' && next != '$' && next != '`' && next != '"' && next != '\\' && next != '\n' {
				current.WriteRune(character)
			} else if next == '\n' {
				index++
			} else {
				escaped = true
				hasToken = true
			}
			continue
		}
		if quote != 0 {
			if character == quote {
				quote = 0
			} else {
				current.WriteRune(character)
			}
			continue
		}
		if character == '"' || character == '\'' {
			quote = character
			hasToken = true
			continue
		}
		if isJSSpace(character) {
			if hasToken {
				tokens = append(tokens, current.String())
				current.Reset()
				hasToken = false
			}
			continue
		}
		current.WriteRune(character)
		hasToken = true
	}
	if escaped {
		current.WriteRune('\\')
	}
	if quote != 0 {
		return nil, errUnbalancedQuote
	}
	if hasToken {
		tokens = append(tokens, current.String())
	}
	if len(tokens) == 0 {
		return nil, errEmptyCommand
	}
	return tokens, nil
}

var shortFlags = regexp.MustCompile(`^-[a-zA-Z]+$`)

// hasFlag reports whether a token after the program name sets a flag: short form combined with
// others (`-rf`, `-fr`, `-Rf`) or long form (`--recursive`). Checking what the flag means rather
// than which of its spellings appears is what catches `-fr` and `--force --recursive` alike.
func hasFlag(tokens []string, shortLetter, long string) bool {
	for _, token := range tokens {
		if token == long {
			return true
		}
		if strings.HasPrefix(token, "--") || !shortFlags.MatchString(token) {
			continue
		}
		if strings.Contains(token[1:], shortLetter) {
			return true
		}
	}
	return false
}

// programIndex is the index of program as the command actually being run: position 0, or 1 behind
// a bare `sudo`; never anywhere else, so `git rm -rf dir` is git, not the filesystem rm.
func programIndex(tokens []string, program string) int {
	if len(tokens) > 0 && strings.ToLower(tokens[0]) == program {
		return 0
	}
	if len(tokens) > 1 && strings.ToLower(tokens[0]) == "sudo" && strings.ToLower(tokens[1]) == program {
		return 1
	}
	return -1
}

// IsRecursiveForceRemoval reports `rm` with both recursive and force, in any order and spelling.
// A command the tokenizer cannot parse is not a match. Tokenized for the platform this runs on, as
// the TypeScript does with process.platform.
func IsRecursiveForceRemoval(command string) bool {
	tokens, err := TokenizeCommand(command, runtime.GOOS)
	if err != nil {
		return false
	}
	rmIndex := programIndex(tokens, "rm")
	if rmIndex == -1 {
		return false
	}
	flags := tokens[rmIndex+1:]
	recursive := hasFlag(flags, "r", "--recursive") || hasFlag(flags, "R", "--recursive")
	force := hasFlag(flags, "f", "--force")
	return recursive && force
}

// IsFindDelete reports `find ... -delete`, as thorough a tree wipe as `rm -rf`.
func IsFindDelete(command string) bool {
	tokens, err := TokenizeCommand(command, runtime.GOOS)
	if err != nil {
		return false
	}
	findIndex := programIndex(tokens, "find")
	if findIndex == -1 {
		return false
	}
	for _, token := range tokens[findIndex+1:] {
		if token == "-delete" {
			return true
		}
	}
	return false
}

// refusedCommandPatterns end a session's worth of work in one keystroke. `rm` and `find -delete`
// are checked by token instead (see above), so `git rm -rf old-directory` is not refused.
var refusedCommandPatterns = []*regexp.Regexp{
	jsRegexp(`\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.)`, false),
	jsRegexp(`\bmkfs\b|\bdd\s+if=`, false),
	jsRegexp(`>\s*\/dev\/sd[a-z]`, false),
	jsRegexp(`:\(\)\s*\{.*\|.*&\s*\}\s*;`, false),
}

// IsRefusedCommand reports a command that is refused outright rather than offered for approval.
func IsRefusedCommand(command string) bool {
	for _, pattern := range refusedCommandPatterns {
		if pattern.MatchString(command) {
			return true
		}
	}
	return IsRecursiveForceRemoval(command) || IsFindDelete(command)
}
