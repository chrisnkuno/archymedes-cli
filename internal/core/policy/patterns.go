package policy

import (
	"regexp"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Pattern approvals, from core/cli/permissions.ts.
//
// A standing approval broader than one exact action, offered only where generalizing is safe: a
// command prefix (never a regex, never a destructive program) or a workspace-relative directory for
// file edits. Everything still passes AssessToolSafety at match time, so a pattern can never
// pre-approve a sensitive call the exact action would have prompted for.

// Pattern kinds.
const (
	PatternCommandPrefix = "command-prefix"
	PatternDirectory     = "directory"
)

// Pattern is a standing rule a human may grant instead of the exact action.
type Pattern struct {
	Kind      string `json:"kind"`
	Prefix    string `json:"prefix,omitempty"`
	Directory string `json:"directory,omitempty"`
	Label     string `json:"label"`
}

// shellOperators chain, substitute or redirect: a command containing any is never generalized.
var shellOperators = regexp.MustCompile("[;&|`$<>(){}\r\n]")

// neverGeneralize: programs whose every invocation deserves its own look.
var neverGeneralize = stringSet(
	"rm", "rmdir", "del", "erase", "rd", "unlink", "shred", "dd", "mkfs", "format", "truncate",
	"mv", "move", "cp", "copy", "ln", "chmod", "chown", "chgrp", "icacls", "takeown",
	"sudo", "su", "doas", "runas",
	"sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd",
	"eval", "exec", "source", "xargs", "env", "nohup", "start", "open", "iex", "invoke-expression",
	"curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "ftp", "rsync", "telnet",
	"kill", "killall", "pkill", "taskkill", "shutdown", "reboot", "halt", "poweroff",
	"systemctl", "service", "launchctl", "crontab", "schtasks", "reg", "setx", "set", "export",
	"find", "docker", "podman", "kubectl", "helm", "terraform", "pulumi", "aws", "gcloud", "az",
	"gh", "heroku", "vercel", "netlify", "fly", "flyctl", "firebase", "railway",
)

// needsSubcommand: programs that only mean something with their next word.
var needsSubcommand = stringSet(
	"node", "python", "python3", "py", "ruby", "perl", "php", "deno", "bun", "java", "dotnet",
	"npm", "pnpm", "yarn", "npx", "bunx", "pnpx", "git", "cargo", "go", "pip", "pip3", "uv", "poetry",
	"make", "mvn", "gradle", "./gradlew", "gradlew", "composer", "bundle", "rake", "mix", "gem",
)

// gitReadOnlyPrefix: the only git subcommands that read without changing refs, index or tree.
var gitReadOnlyPrefix = stringSet("status", "diff", "log", "show", "blame", "grep", "ls-files", "rev-parse", "describe", "shortlog", "fetch")

// packageRisky: subcommands that publish, authenticate or install arbitrary code.
var packageRisky = stringSet(
	"publish", "unpublish", "deprecate", "owner", "access", "login", "logout", "adduser", "token", "dist-tag", "link",
	"version", "install", "i", "add", "remove", "uninstall", "rm", "un", "update", "upgrade", "up", "yank", "release",
)

var packageManagers = stringSet("npm", "pnpm", "yarn", "bun", "cargo", "pip", "pip3", "uv", "poetry", "composer", "bundle", "gem")

// runnerSubcommands run something named by the next word, so the prefix must include it.
var runnerSubcommands = stringSet("run", "run-script", "exec", "x", "dlx")

var (
	programSuffix = regexp.MustCompile(`\.(?:exe|cmd|bat|ps1)$`)
	plainWord     = regexp.MustCompile(`^[A-Za-z0-9@.][\w@./:-]*$`)
	driveLetter   = regexp.MustCompile(`^[A-Za-z]:`)
	leadingDotDir = regexp.MustCompile(`^(?:\./)+`)
)

func programName(token string) string {
	return programSuffix.ReplaceAllString(strings.ToLower(token), "")
}

// CommandApprovalPrefix is the prefix "always allow commands starting with …" would cover, or ""
// when the command must not be generalized. One word for a self-contained tool (`ls -la` -> `ls`),
// two for a program that needs its next word (`npm test`, `git status`), three for a script runner
// (`npm run build`).
func CommandApprovalPrefix(command string) string {
	trimmed := jsTrim(command)
	if trimmed == "" || utf16Len(trimmed) > 500 || shellOperators.MatchString(trimmed) {
		return ""
	}
	tokens := jsFields(trimmed)
	program := programName(tokens[0])
	if neverGeneralize[program] {
		return ""
	}
	// A plain word: never a flag, so `node -e …` and `python -c …` are never generalized.
	word := func(index int) bool { return index < len(tokens) && plainWord.MatchString(tokens[index]) }
	if !needsSubcommand[program] {
		if word(0) {
			return tokens[0]
		}
		return ""
	}
	if !word(1) {
		return ""
	}
	subcommand := strings.ToLower(tokens[1])
	if program == "git" && !gitReadOnlyPrefix[subcommand] {
		return ""
	}
	if packageManagers[program] && packageRisky[subcommand] {
		return ""
	}
	if (packageManagers[program] || program == "npx" || program == "bunx" || program == "pnpx") && runnerSubcommands[subcommand] {
		if word(2) {
			return strings.Join(tokens[:3], " ")
		}
		return ""
	}
	return strings.Join(tokens[:2], " ")
}

// CommandMatchesPrefix reports whether command is covered by a granted prefix: same leading words,
// and itself safe to generalize.
func CommandMatchesPrefix(command, prefix string) bool {
	if CommandApprovalPrefix(command) == "" {
		return false
	}
	tokens := jsFields(command)
	wanted := jsFields(prefix)
	if len(wanted) == 0 || len(wanted) > len(tokens) {
		return false
	}
	for index, token := range wanted {
		if tokens[index] != token {
			return false
		}
	}
	return true
}

// protectedSegments hold configuration of the tool or repository, never covered by a directory rule.
var protectedSegments = stringSet(".git", ".archymedes", ".ssh", ".aws", ".gnupg")

// relativeEditPath is a workspace-relative, forward-slash path, or "" for anything absolute or escaping.
func relativeEditPath(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	normalized := leadingDotDir.ReplaceAllString(strings.ReplaceAll(jsTrim(text), `\`, "/"), "")
	if normalized == "" || strings.HasPrefix(normalized, "/") || driveLetter.MatchString(normalized) || strings.HasPrefix(normalized, "~") {
		return ""
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == ".." || segment == "." || segment == "" || protectedSegments[strings.ToLower(segment)] {
			return ""
		}
	}
	return normalized
}

// EditApprovalDirectory is the directory "always allow edits under …" would cover: the edited
// file's own folder, never the workspace root. "" when there is none.
func EditApprovalDirectory(filePath any) string {
	relative := relativeEditPath(filePath)
	if slash := strings.LastIndexByte(relative, '/'); slash > 0 {
		return relative[:slash]
	}
	return ""
}

// PathUnderDirectory reports whether a file path lies under a granted directory, by whole path
// segments (`src/a` never covers `src/ab`).
func PathUnderDirectory(filePath any, directory string) bool {
	relative := relativeEditPath(filePath)
	return relative != "" && directory != "" && strings.HasPrefix(relative, directory+"/")
}

var editTools = stringSet("edit_file", "write_file")

// SuggestPattern is the broader rule a human may grant for this call, if any. Only Friday's own
// run_command, edit_file and write_file qualify, and only when the exact call is not sensitive.
func SuggestPattern(call tool.Call, t *tool.Tool, s Safety) *Pattern {
	if !t.Provenance.BuiltIn() || t.Effect != tool.EffectWorkspace || s.Sensitive {
		return nil
	}
	if command, ok := call.Args["command"].(string); t.Name == "run_command" && ok {
		if prefix := CommandApprovalPrefix(command); prefix != "" {
			return commandPattern(prefix)
		}
		return nil
	}
	if editTools[t.Name] {
		if directory := EditApprovalDirectory(call.Args["path"]); directory != "" {
			return directoryPattern(directory)
		}
	}
	return nil
}

func commandPattern(prefix string) *Pattern {
	return &Pattern{Kind: PatternCommandPrefix, Prefix: prefix, Label: `always allow commands starting with "` + prefix + `"`}
}

func directoryPattern(directory string) *Pattern {
	return &Pattern{Kind: PatternDirectory, Directory: directory, Label: "always allow edits under " + directory + "/"}
}

const (
	prefixScope    = ApprovalPolicyVersion + ":prefix:run_command:"
	directoryScope = ApprovalPolicyVersion + ":dir:edit:"
)

// PatternScopeKey is the persisted key for a granted pattern, versioned like exact keys.
func PatternScopeKey(p Pattern) string {
	if p.Kind == PatternCommandPrefix {
		return prefixScope + p.Prefix
	}
	return directoryScope + p.Directory
}

func patternFromScopeKey(scope string) *Pattern {
	if rest, ok := strings.CutPrefix(scope, prefixScope); ok {
		return commandPattern(rest)
	}
	if rest, ok := strings.CutPrefix(scope, directoryScope); ok {
		return directoryPattern(rest)
	}
	return nil
}
