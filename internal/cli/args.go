// Package cli decides what one invocation of `archymedes` is: an interactive session the Go front
// end draws, or anything else, which goes to the agent unchanged.
//
// The agent (packages/friday-cli, run as `friday acp` behind the UI) still owns every
// non-interactive mode — `--json`, piped prompts, `doctor`, `update`, `history`, `settings` — and
// every flag about the session itself. This package does not re-implement its parser. It only needs
// to know which flags take a value, so that a flag's value is never mistaken for words of the
// prompt; those rules mirror parseArgs in packages/friday-cli/src/cli/args.ts.
package cli

import (
	"regexp"
	"slices"
	"strings"
)

// Invocation is one command line, split.
type Invocation struct {
	// Passthrough means: run the agent with Args and nothing else. False means an interactive session.
	Passthrough bool
	// Args is what the agent receives: the whole command line (minus Go-only flags) for passthrough,
	// or the session flags to put after `acp` for an interactive session.
	Args []string
	// Prompt is the request typed on the command line, sent once the session opens.
	Prompt string

	// Go-only: these never reach the agent.
	Theme string
	Agent string
	// Engine is which agent runs the session: "go" for the Go engine, "" or "ts" for the TypeScript one.
	Engine  string
	Cwd     string
	NoMouse bool
	Help    bool
	Version bool
	// Resume is a session id or "latest" for an interactive session; empty starts a new one.
	Resume string
	// Refused, when set, is why this interactive session cannot start as asked.
	Refused string
}

// interactiveRefused are flags the interactive interface cannot honour yet. Ignoring one would be
// worse than refusing: someone who asked for a spending cap must never run without one.
var interactiveRefused = map[string]string{
	"--budget":  "--budget is not supported in the interactive interface yet; use --json for a capped run",
	"--max-rwf": "--max-rwf is not supported in the interactive interface yet; use --json for a capped run",
}

// subcommands are the agent's own verbs; each is a non-interactive mode.
var subcommands = []string{"acp", "bridge", "login", "logout", "account", "keys", "update", "settings", "history", "doctor"}

// passthroughFlags put the agent in a mode that is not a terminal session.
var passthroughFlags = []string{"--acp", "--json", "--headless", "--doctor", "--update", "--check-update", "--settings", "--providers", "--sessions", "--estimate"}

// valueFlags always consume the next argument.
var valueFlags = []string{"--package-manager", "--cwd", "--image", "--sandbox-minutes", "--docker-image", "--budget", "--max-rwf", "--model", "--location", "--country", "--language", "--lang", "--provider", "--currency", "--layout"}

var (
	sessionID = regexp.MustCompile(`^\d{8}T\d{6}Z-[a-z0-9]{6}$`)
	themeWord = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	paceWords = []string{"on", "gentle", "slow", "strict", "very", "max", "off", "none", "full"}
)

// goOnlyFlags are read by the Go binary and never reach the agent.
var goOnlyFlags = []string{"--theme", "--agent", "--engine", "-C", "--cwd", "--no-mouse", "--help", "-h", "--version", "-v", "--resume"}

// sessionFlags are the agent's switches for a session that take no value (the mode, free models).
var sessionFlags = []string{"--plan", "-p", "--build", "--auto", "-y", "--defender", "--free", "--slow", "--pace", "--sandbox"}

// GoOnlyFlags is every flag only the Go binary reads; `friday --help` must name each one.
func GoOnlyFlags() []string { return slices.Clone(goOnlyFlags) }

// KnownFlags is every flag this package recognizes, for checking that what `--help` names is real.
func KnownFlags() []string {
	out := slices.Concat(goOnlyFlags, sessionFlags, valueFlags, passthroughFlags)
	slices.Sort(out)
	return slices.Compact(out)
}

// Parse splits argv (without the program name). interactive is whether both stdin and stdout are
// terminals; without one, there is no session to draw and everything passes through.
func Parse(argv []string, interactive bool) Invocation {
	inv := Invocation{}
	// full is the command line for a passthrough run; session is what follows `acp` for an
	// interactive one, which carries neither the prompt (sent through the UI) nor --resume (sent as
	// session/load). Both are built in one pass, so a value is never mistaken for a prompt word.
	var full, session, prompt []string
	flag := func(items ...string) { full = append(full, items...); session = append(session, items...) }
	passthrough := !interactive || (len(argv) > 0 && slices.Contains(subcommands, argv[0]))

	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		next := ""
		if i+1 < len(argv) {
			next = argv[i+1]
		}
		name, value, hasValue := strings.Cut(arg, "=")
		switch {
		case arg == "--":
			// Everything after is the request, even when it looks like a flag.
			prompt = append(prompt, argv[i+1:]...)
			full = append(full, argv[i:]...)
			i = len(argv)
		case name == "--theme":
			// Kept for the agent: in passthrough modes it themes the agent's own output.
			if hasValue {
				inv.Theme = value
				full = append(full, arg)
			} else if next != "" && !strings.HasPrefix(next, "-") && themeWord.MatchString(next) {
				inv.Theme = next
				full = append(full, arg, next)
				i++
			}
		case name == "--agent":
			inv.Agent, i = flagValue(hasValue, value, next, i)
		case name == "--engine":
			inv.Engine, i = flagValue(hasValue, value, next, i)
		case name == "-C" || name == "--cwd":
			inv.Cwd, i = flagValue(hasValue, value, next, i)
			flag("--cwd", inv.Cwd)
		case arg == "--no-mouse":
			inv.NoMouse = true
		case arg == "--help" || arg == "-h":
			inv.Help = true
		case arg == "--version" || arg == "-v":
			inv.Version = true
		case arg == "--resume":
			inv.Resume = "latest"
			full = append(full, arg)
			if next == "latest" || sessionID.MatchString(next) {
				inv.Resume = next
				full = append(full, next)
				i++
			}
		case arg == "--slow" || arg == "--pace":
			flag(arg)
			if slices.Contains(paceWords, strings.ToLower(next)) {
				flag(next)
				i++
			}
		case arg == "--sandbox":
			flag(arg)
			if next == "local" || next == "e2b" || next == "docker" {
				flag(next)
				i++
			}
		case slices.Contains(valueFlags, name):
			flag(arg)
			if !hasValue && next != "" {
				flag(next)
				i++
			}
		case slices.Contains(passthroughFlags, name):
			passthrough = true
			flag(arg)
		case strings.HasPrefix(arg, "-") && arg != "-":
			flag(arg) // a session flag the agent knows and we need not
		default:
			prompt = append(prompt, arg)
			full = append(full, arg)
		}
	}

	inv.Passthrough = passthrough && !inv.Help && !inv.Version
	if inv.Passthrough {
		inv.Args = full
		return inv
	}
	inv.Args, inv.Prompt = session, strings.Join(prompt, " ")
	for _, arg := range session {
		name, _, _ := strings.Cut(arg, "=")
		if why, ok := interactiveRefused[name]; ok {
			inv.Refused = why
		}
	}
	return inv
}

func flagValue(hasValue bool, value, next string, i int) (string, int) {
	if hasValue {
		return value, i
	}
	if next != "" {
		return next, i + 1
	}
	return "", i
}
