// Command friday is the Friday CLI.
//
// The interactive session is drawn here, in Go, and by default the agent behind it is the Go engine
// in this same process (internal/core, engine.go), driven over the Agent Client Protocol
// (internal/acp). The TypeScript agent, run as `friday acp`, takes a session that needs what only
// it has (see chooseEngine); and every
// non-interactive mode — `--json`, piped prompts, `doctor`, `update`, `history`, `settings` — is
// handed to it unchanged (internal/cli decides which is which).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/log/v2"
	"github.com/charmbracelet/x/term"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/cli"
	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/tui"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	interactive := term.IsTerminal(os.Stdin.Fd()) && term.IsTerminal(os.Stdout.Fd())
	inv := cli.Parse(args, interactive)
	switch {
	case inv.Version:
		fmt.Println("friday", version)
		return 0
	case inv.Help:
		fmt.Print(usage)
		return 0
	}

	cwd := inv.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	cwd, _ = filepath.Abs(cwd)

	agent, agentErr := agentCommand(firstNonEmpty(inv.Agent, os.Getenv("ARCHYMEDES_AGENT")), cwd)
	// A scripted run is judged by its session flags, not by --json, which is the run's own.
	scripted, asJSON, isScripted := scriptedRun(args, interactive)
	factsArgs, resume := inv.Args, inv.Resume
	if isScripted {
		factsArgs, resume = scripted.Args, scripted.Resume
	}
	choice, err := chooseEngine(engineFactsFor(inv.Engine, factsArgs, cwd, resume, agentErr == nil))
	if err != nil {
		fmt.Fprintln(os.Stderr, "friday:", err)
		return 2
	}
	goEngine := choice.goEngine
	logger := debugLog()
	if logger != nil {
		logger.Info("engine", "go", goEngine, "explicit", choice.explicit, "why", choice.why)
	}
	// The Go engine serves ACP itself; every other non-interactive mode is still the TypeScript agent's.
	if goEngine && inv.Passthrough && len(inv.Args) > 0 && (inv.Args[0] == "acp" || inv.Args[0] == "--acp") {
		opts, oerr := engineOptions(inv.Args, cwd)
		if oerr != nil {
			fmt.Fprintln(os.Stderr, "friday:", oerr)
			return 2
		}
		return serveGoEngine(opts, &lazyAgent{argv: agent, cwd: cwd})
	}
	if goEngine && isScripted {
		opts, oerr := engineOptions(scripted.Args, cwd)
		if oerr != nil {
			fmt.Fprintln(os.Stderr, "friday:", oerr)
			return 2
		}
		var stdin io.Reader
		if !term.IsTerminal(os.Stdin.Fd()) {
			stdin = os.Stdin
		}
		return runScripted(scripted, asJSON, opts, &lazyAgent{argv: agent, cwd: cwd}, stdin, os.Stdout, os.Stderr)
	}
	// The TypeScript agent is needed for the modes it alone serves; the Go engine only borrows it,
	// for settings and providers, when it is there.
	if agentErr != nil && (inv.Passthrough || !goEngine) {
		fmt.Fprintln(os.Stderr, "friday:", agentErr)
		return 2
	}
	if inv.Passthrough {
		// --print is the Go engine's word for a plain scripted run; the TypeScript agent's is none.
		return execAgent(append(agent, slices.DeleteFunc(slices.Clone(inv.Args), func(a string) bool { return a == "--print" })...))
	}
	if inv.Refused != "" {
		fmt.Fprintln(os.Stderr, "friday:", inv.Refused)
		return 2
	}

	argv := append(append(agent, "acp"), inv.Args...)
	start := func(ctx context.Context) (tui.Agent, error) {
		return acp.Start(ctx, argv, cwd, os.Environ())
	}
	if goEngine {
		opts, oerr := engineOptions(inv.Args, cwd)
		if oerr != nil {
			fmt.Fprintln(os.Stderr, "friday:", oerr)
			return 2
		}
		start = startGoEngine(opts, &lazyAgent{argv: agent, cwd: cwd})
	}
	ui := tui.New(tui.Options{
		Theme: firstNonEmpty(inv.Theme, os.Getenv("ARCHYMEDES_THEME")), Start: start, Resume: inv.Resume, Prompt: inv.Prompt,
		Mouse: !inv.NoMouse, Cwd: cwd, Version: version, AgentArgv: agent,
		Motion: os.Getenv("ARCHYMEDES_REDUCE_MOTION") == "",
		Debug:  logger, ConfigDir: config.Default(),
		NoPhotos:      photosOff(os.Getenv("ARCHYMEDES_PHOTOS")),
		NoWallpaper:   photosOff(os.Getenv("ARCHYMEDES_WALLPAPER")),
		PhotosOffline: strings.EqualFold(strings.TrimSpace(os.Getenv("ARCHYMEDES_PHOTOS")), "local"),
	})
	program := tea.NewProgram(ui)
	ui.SetSender(program.Send)
	if _, err := program.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "friday:", err)
		return 1
	}
	return 0
}

// photosOff is ARCHYMEDES_PHOTOS saying no: the interface is then text only.
func photosOff(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "off", "0", "false", "no":
		return true
	}
	return false
}

// debugLog opens ARCHYMEDES_DEBUG_LOG for appending, or returns nil (no logging) when unset or
// unopenable: a debug log must never be the reason the interface does not start.
func debugLog() *log.Logger {
	path := strings.TrimSpace(os.Getenv("ARCHYMEDES_DEBUG_LOG"))
	if path == "" {
		return nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "friday: debug log not opened:", err)
		return nil
	}
	return tui.NewDebugLog(f)
}

// agentCommand finds the TypeScript agent: an explicit command (the npm launcher sets
// ARCHYMEDES_AGENT to the bundled one), then this repository's source run with bun (a development
// checkout), then an installed `friday` that is not this binary. Not an installed `archymedes`: that
// is the package before the rename, and starting its older agent fails in ways that look like setup.
func agentCommand(explicit, cwd string) ([]string, error) {
	if explicit = strings.TrimSpace(explicit); explicit != "" {
		// A JSON array survives paths with spaces (`C:\Program Files\nodejs\node.exe`); the npm
		// launcher always uses that form. A plain string is split on spaces, for typing by hand.
		if strings.HasPrefix(explicit, "[") {
			var argv []string
			if err := json.Unmarshal([]byte(explicit), &argv); err != nil || len(argv) == 0 {
				return nil, fmt.Errorf("ARCHYMEDES_AGENT is not a JSON array of strings: %s", explicit)
			}
			return argv, nil
		}
		return strings.Fields(explicit), nil
	}
	self, _ := os.Executable()
	self, _ = filepath.EvalSymlinks(self)
	for _, start := range []string{filepath.Dir(self), cwd} {
		if entry := findUp(start, filepath.Join("packages", "friday-cli", "src", "friday.ts")); entry != "" {
			if bun, err := exec.LookPath("bun"); err == nil {
				return []string{bun, "run", entry}, nil
			}
		}
	}
	if path, err := exec.LookPath("friday"); err == nil {
		if resolved, _ := filepath.EvalSymlinks(path); resolved != self {
			return []string{path}, nil
		}
	}
	return nil, errors.New("cannot find the Friday agent: reinstall with `npm install -g @archymedes/friday`, or set ARCHYMEDES_AGENT")
}

func findUp(start, rel string) string {
	for dir := start; ; dir = filepath.Dir(dir) {
		if info, err := os.Stat(filepath.Join(dir, rel)); err == nil && !info.IsDir() {
			return filepath.Join(dir, rel)
		}
		if parent := filepath.Dir(dir); parent == dir {
			return ""
		}
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

const usage = `Friday — a coding agent that shows its work.

Start:
  friday                        open a session in this folder
  friday "fix the failing test" open a session that starts with that request
  friday --resume latest        continue your last session here (or --resume <id>)

Without opening a session:
  friday --print "request"      run one request and print the answer (progress goes to stderr)
  friday --json "request"       the same, as JSON lines on stdout for another program to read
  echo "request" | friday       a request from a pipe; with no terminal, friday "request" too
                                (nobody can approve here: what would ask is refused; --auto allows more)
  friday settings               set API keys, models and preferences
  friday history                list earlier sessions (friday history search <words> to find one)
  friday doctor                 check your keys, connection and setup, and say what is wrong
  friday update                 install the newest Friday
  friday login | logout         sign in to (or out of) your archymedes.xyz account
  friday account | keys         who this computer is linked as; the provider keys your account holds
  friday acp                    talk to an editor (Zed, JetBrains) instead of a terminal

How much Friday may do on its own (shift+tab switches in a session):
  --plan, -p        read and propose; change nothing
  --build           every edit and command asks you first (the default)
  --auto, -y        edits and commands run unasked; risky ones still ask
  --defender        find and fix security problems; every change asks

Which model:
  --provider <id>   anthropic, openai, openrouter, google, xai, deepseek, mistral, groq,
                    ollama, openai-compatible, claude (Claude Code), codex
  --model <id>      a model of that provider
  --free            free models only, through OpenRouter

Where it works:
  -C, --cwd <dir>   the project folder (default: this one)
  --sandbox local|docker|e2b   run commands here, in a Docker container, or in a remote E2B sandbox
  --budget <n>      stop a --json run once it has spent this much

The screen:
  --theme <name>    archymedes-blue (default), archymedes, blueprint, chalkboard,
                    high-contrast, parchment, rainbow
  --no-mouse        leave the mouse to the terminal, so you can select text

The engine (you rarely need these: Friday picks on its own):
  --engine ts       use the TypeScript engine, which runs Codex, sandboxes, /undo and /cost;
                    the Go engine is the default (also ARCHYMEDES_ENGINE, or
                    Settings → Engine)
  --agent <command> drive a different agent program over ACP

  --version, -v     print the version
  --help, -h        print this

In a session: enter sends · \ enter or ctrl+j adds a line · / or ctrl+p lists commands · ? lists keys ·
esc stops the agent · ctrl+c twice quits.
`
