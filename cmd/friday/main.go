// Command archymedes is the Archymedes CLI.
//
// The interactive session is drawn here, in Go. The agent behind it is still the TypeScript one,
// run as `archymedes acp` and driven over the Agent Client Protocol (internal/acp), and every
// non-interactive mode — `--json`, piped prompts, `doctor`, `update`, `history`, `settings` — is
// handed to it unchanged (internal/cli decides which is which).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
		fmt.Println("archymedes", version)
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

	agent, err := agentCommand(firstNonEmpty(inv.Agent, os.Getenv("ARCHYMEDES_AGENT")), cwd)
	if err != nil {
		fmt.Fprintln(os.Stderr, "archymedes:", err)
		return 2
	}
	if inv.Passthrough {
		return execAgent(append(agent, inv.Args...))
	}
	if inv.Refused != "" {
		fmt.Fprintln(os.Stderr, "archymedes:", inv.Refused)
		return 2
	}

	argv := append(append(agent, "acp"), inv.Args...)
	start := func(ctx context.Context) (tui.Agent, error) {
		return acp.Start(ctx, argv, cwd, os.Environ())
	}
	ui := tui.New(tui.Options{
		Theme: firstNonEmpty(inv.Theme, os.Getenv("ARCHYMEDES_THEME")), Start: start, Resume: inv.Resume, Prompt: inv.Prompt,
		Mouse: !inv.NoMouse, Cwd: cwd, Version: version, AgentArgv: agent,
		Motion: os.Getenv("ARCHYMEDES_REDUCE_MOTION") == "",
		Debug:  debugLog(), ConfigDir: config.Default(),
		NoPhotos:      photosOff(os.Getenv("ARCHYMEDES_PHOTOS")),
		NoWallpaper:   photosOff(os.Getenv("ARCHYMEDES_WALLPAPER")),
		PhotosOffline: strings.EqualFold(strings.TrimSpace(os.Getenv("ARCHYMEDES_PHOTOS")), "local"),
	})
	program := tea.NewProgram(ui)
	ui.SetSender(program.Send)
	if _, err := program.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "archymedes:", err)
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
		fmt.Fprintln(os.Stderr, "archymedes: debug log not opened:", err)
		return nil
	}
	return tui.NewDebugLog(f)
}

// agentCommand finds the TypeScript agent: an explicit command (the npm launcher sets
// ARCHYMEDES_AGENT to the bundled one), then this repository's source run with bun (a development
// checkout), then an installed `archymedes` that is not this binary.
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
		if entry := findUp(start, filepath.Join("packages", "archymedes-cli", "src", "friday.ts")); entry != "" {
			if bun, err := exec.LookPath("bun"); err == nil {
				return []string{bun, "run", entry}, nil
			}
		}
	}
	if path, err := exec.LookPath("archymedes"); err == nil {
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

const usage = `Archymedes — a coding agent that shows its work.

Usage:
  archymedes [flags] [request]          start a session (with a first request, if given)
  archymedes --json "request"           run one request headless; JSON lines on stdout
  echo "request" | archymedes           the same, from a pipe
  archymedes history | doctor | update | settings | acp

Session:
  --plan, -p   --build   --auto, -y   --defender        start in a mode (shift+tab cycles)
  --provider <id>   --model <id>   --free               choose the model
  --resume [id|latest]                                  continue an earlier session
  --sandbox [local|docker|e2b]   --budget <n>           where the work runs, and its ceiling
  -C, --cwd <dir>                                       project directory

Interface:
  --theme <name>     archymedes-blue (default), archymedes, blueprint, chalkboard,
                     high-contrast, parchment, rainbow
  --no-mouse         leave the mouse to the terminal (text selection) instead of wheel scrolling
  --agent <command>  run a different agent over ACP (default: the bundled one)
  --version, --help

In a session: enter sends · \ enter or ctrl+j new line · ctrl+p commands · ? keys · esc stops a turn · ctrl+c twice quits.
`
