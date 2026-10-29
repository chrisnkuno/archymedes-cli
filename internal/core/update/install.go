package update

import (
	"context"
	"os"
	"os/exec"
	"strings"
)

// Manager is a package manager that installs a global CLI.
type Manager string

const (
	NPM  Manager = "npm"
	PNPM Manager = "pnpm"
	Yarn Manager = "yarn"
	Bun  Manager = "bun"
)

// DetectManager works out how Friday was installed, so the update uses the same tool. An explicit
// ARCHYMEDES_PACKAGE_MANAGER wins; otherwise npm's own user-agent and the running binary's path are
// read for clues, and npm is the conservative default when nothing says otherwise.
func DetectManager(get func(string) string, executable string) Manager {
	if m := manager(strings.ToLower(strings.TrimSpace(get("ARCHYMEDES_PACKAGE_MANAGER")))); m != "" {
		return m
	}
	if ua := get("npm_config_user_agent"); ua != "" {
		if m := manager(strings.ToLower(strings.SplitN(ua, "/", 2)[0])); m != "" {
			return m
		}
	}
	clue := strings.ToLower(executable + "/" + get("npm_execpath"))
	switch {
	case strings.Contains(clue, "pnpm"):
		return PNPM
	case strings.Contains(clue, "yarn"):
		return Yarn
	case strings.Contains(clue, "bun"):
		return Bun
	default:
		return NPM
	}
}

func manager(s string) Manager {
	switch Manager(s) {
	case NPM, PNPM, Yarn, Bun:
		return Manager(s)
	default:
		return ""
	}
}

// InstallArgv is the exact program and arguments to install one version globally — argv, never
// shell text, so a registry's version string can never become executable syntax. The version must
// already be validated (releaseParts) before this is called.
func InstallArgv(m Manager, pkg, version string) (string, []string) {
	target := pkg + "@" + version
	switch m {
	case PNPM:
		return "pnpm", []string{"add", "--global", target}
	case Yarn:
		return "yarn", []string{"global", "add", target}
	case Bun:
		return "bun", []string{"add", "--global", target}
	default:
		return "npm", []string{"install", "--global", target}
	}
}

// Install replaces the global CLI with version through its package manager. It runs outside any
// project directory so a workspace's settings cannot change the meaning of a global install, with
// shell disabled (a security invariant, not an optimization), and silently — the outcome is the
// notice, and a package manager's progress output has no business on a prompt. It returns whether
// the install exited cleanly.
func Install(ctx context.Context, get func(string) string, pkg, version string) bool {
	if _, ok := releaseParts(version); !ok {
		return false // never install a version that is not a plain release
	}
	exe, _ := os.Executable()
	name, args := InstallArgv(DetectManager(get, exe), pkg, version)
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = os.TempDir()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	return cmd.Run() == nil
}
