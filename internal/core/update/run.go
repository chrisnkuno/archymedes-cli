package update

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Options is one round of the policy: what is known, and the two things it may do (look at the
// registry, install a version), each injectable so a run is testable without network or installs.
type Options struct {
	Mode           Mode
	Interactive    bool
	CurrentVersion string
	Package        string
	ConfigDir      string
	Getenv         func(string) string
	Now            time.Time
	// Fetch and Do default to the registry check and the package-manager install; tests replace them.
	Fetch func(ctx context.Context, get func(string) string, pkg string) (string, error)
	Do    func(ctx context.Context, get func(string) string, pkg, version string) bool
	// MoveAside moves the running executable (Executable, default this process's) out of the way
	// before installing, and back if the install fails: Windows will not let a running program be
	// overwritten, only renamed. Set on Windows (aside.go).
	MoveAside  bool
	Executable string
	// Boundary says the caller is at a moment when no Friday of its own is running from this install
	// (it has just exited). Only then may a version be installed: an install replaces files a live
	// session loads on demand. Without it an install that is due is announced and left for that
	// moment, so the default is the safe one.
	Boundary bool
}

// Run runs one round: decide, look if due, act if there is something to act on. It returns the
// lines to show the person, and never panics or blocks beyond the bounded fetch — upkeep must not
// be why a session fails to start.
func Run(ctx context.Context, o Options) []string {
	if o.Getenv == nil {
		o.Getenv = func(string) string { return "" }
	}
	if o.Package == "" {
		o.Package = Package
	}
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	fetch, do := o.Fetch, o.Do
	if fetch == nil {
		fetch = FetchLatest
	}
	if do == nil {
		do = Install
	}

	if o.MoveAside {
		clearAside(o.Executable, o.ConfigDir) // what earlier updates moved aside, once nothing runs it
	}
	state := readState(o.ConfigDir)
	if state != nil && state.Installing != "" && o.Now.UnixMilli()-state.InstallingAt >= lockStale.Milliseconds() {
		// An install that started long ago and never finished: forgotten, and its version is tried
		// again. (A recent one belongs to a process that is still installing; Decide waits for it.)
		cleared := *state
		cleared.Installing, cleared.InstallingAt = "", 0
		state = &cleared
		writeState(o.ConfigDir, state)
	}
	in := Inputs{Mode: o.Mode, Interactive: o.Interactive, CI: isCI(o.Getenv), CurrentVersion: o.CurrentVersion, State: state, Now: o.Now}
	decision := Decide(in)

	if decision.Action == ActionCheck {
		latest, err := fetch(ctx, o.Getenv, o.Package)
		next := &State{LastCheckedAt: o.Now.UnixMilli()}
		if state != nil {
			next.SkippedVersion, next.InstalledVersion = state.SkippedVersion, state.InstalledVersion
		}
		if err == nil {
			next.LatestVersion = latest
		}
		writeState(o.ConfigDir, next)
		if err != nil {
			return nil // an unreachable registry is nothing anyone asked about; the stamp still moved
		}
		in.State = next
		decision = Decide(in)
	}

	switch decision.Action {
	case ActionNotify:
		return notify(decision.Version, o.CurrentVersion)
	case ActionInstall:
		if !o.Boundary {
			// A live session is using these files. Say it is ready and let the exit install it.
			return readyAtExit(decision.Version, o.CurrentVersion)
		}
		if othersRunning(o.ConfigDir, o.Now) > 0 {
			return nil // another Friday is running from this install; whichever closes last installs
		}
		release, ok := acquireInstallLock(o.ConfigDir, o.Now)
		if !ok {
			return nil // another process is installing right now; it will report
		}
		defer release()
		// Marked before the package manager starts, so an install cut short is found and retried.
		writeState(o.ConfigDir, &State{LastCheckedAt: o.Now.UnixMilli(), LatestVersion: decision.Version, SkippedVersion: stateSkipped(in.State), Installing: decision.Version, InstallingAt: o.Now.UnixMilli()})
		restore := func() {}
		if o.MoveAside {
			back, err := setAside(o.Executable, o.ConfigDir, o.Now)
			if err != nil {
				writeState(o.ConfigDir, &State{LastCheckedAt: o.Now.UnixMilli(), LatestVersion: decision.Version, SkippedVersion: stateSkipped(in.State)})
				return nil // nowhere to move it: the install would only fail; the next check tries again
			}
			restore = back
		}
		installedOK := do(ctx, o.Getenv, o.Package, decision.Version)
		if installedOK && o.MoveAside && !programInPlace(o.Executable) {
			// The package manager said yes but wrote the program somewhere else (another prefix, pnpm,
			// bun): nothing is at the launch path any more, so put the old one back rather than leave
			// no friday to start.
			installedOK = false
		}
		if installedOK {
			done := &State{LastCheckedAt: o.Now.UnixMilli(), LatestVersion: decision.Version, InstalledVersion: decision.Version, SkippedVersion: stateSkipped(in.State)}
			writeState(o.ConfigDir, done)
			return installed(decision.Version)
		}
		restore()
		if ctx.Err() != nil {
			// Cut short (interrupted, timed out), not refused: nothing says this version is bad, so it
			// is tried again next time rather than skipped for good.
			writeState(o.ConfigDir, &State{LastCheckedAt: o.Now.UnixMilli(), LatestVersion: decision.Version, SkippedVersion: stateSkipped(in.State)})
			return nil
		}
		// A failed install is remembered as skipped: retrying the same broken version at every
		// launch is how an update mechanism becomes something people uninstall.
		writeState(o.ConfigDir, &State{LastCheckedAt: o.Now.UnixMilli(), LatestVersion: decision.Version, SkippedVersion: decision.Version})
		return []string{"Could not install Friday " + decision.Version + " automatically. Run `friday update` to see why."}
	default:
		return nil
	}
}

// isCI reports a continuous-integration environment, where a build server's tools must never be
// swapped mid-build.
func isCI(get func(string) string) bool {
	for _, name := range []string{"CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION"} {
		if strings.TrimSpace(get(name)) != "" {
			return true
		}
	}
	return false
}

func stateFile(configDir string) string { return filepath.Join(configDir, "update-check.json") }

// readState is the last check, or nil when there has never been one — or the file is unreadable,
// which reads the same: check now, the safe reading, since the cost is one request.
func readState(configDir string) *State {
	if configDir == "" {
		return nil
	}
	data, err := os.ReadFile(stateFile(configDir))
	if err != nil {
		return nil
	}
	var s State
	if json.Unmarshal(data, &s) != nil || s.LastCheckedAt <= 0 {
		return nil
	}
	return &s
}

// writeState records a check, best effort: a read-only config directory must not fail a session,
// and losing the stamp costs one extra check tomorrow.
func writeState(configDir string, s *State) {
	if configDir == "" {
		return
	}
	if os.MkdirAll(configDir, 0o755) != nil {
		return
	}
	if data, err := json.MarshalIndent(s, "", "  "); err == nil {
		_ = os.WriteFile(stateFile(configDir), append(data, '\n'), 0o644)
	}
}

// programInPlace reports whether a program exists at the launch path after an install moved the old
// one aside. An empty path means the running executable, as setAside resolves it.
func programInPlace(exe string) bool {
	if exe == "" {
		var err error
		if exe, err = os.Executable(); err != nil {
			return false
		}
	}
	_, err := os.Stat(exe)
	return err == nil
}

// stateSkipped is the skipped version the last state carried, which a new state must keep.
func stateSkipped(s *State) string {
	if s == nil {
		return ""
	}
	return s.SkippedVersion
}

// readyAtExit is the line shown when a newer version is known but this session is still using the
// files it would replace.
func readyAtExit(version, current string) []string {
	return []string{"Friday " + version + " is ready (you have " + current + "). It installs when you close Friday."}
}

// AtExit is the boundary: a session has just ended, so nothing of this process is using the files.
// It installs a newer version that an earlier check found, if no other Friday is running, and says
// so before it starts, because an install takes a moment and the terminal would otherwise look
// frozen. It never looks at the registry itself (that would make closing Friday wait on the
// network), and it stops at once if ctx is cancelled, which the caller ties to Ctrl-C.
func AtExit(ctx context.Context, o Options, say func(string)) []string {
	if o.Getenv == nil {
		o.Getenv = func(string) string { return "" }
	}
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	state := readState(o.ConfigDir)
	d := Decide(Inputs{Mode: o.Mode, Interactive: o.Interactive, CI: isCI(o.Getenv), CurrentVersion: o.CurrentVersion, State: state, Now: o.Now})
	if d.Action != ActionInstall || othersRunning(o.ConfigDir, o.Now) > 0 {
		return nil
	}
	if say != nil {
		say("Installing Friday " + d.Version + " (Ctrl-C to skip)...")
	}
	o.Boundary = true
	return Run(ctx, o)
}
