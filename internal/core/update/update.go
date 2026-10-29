// Package update keeps the installed CLI current without getting in the way: a daily check against
// the package registry and, by default, a silent install of a newer version at a safe moment. It
// is the Go port of packages/friday-cli/src/platform/auto-update.ts and update.ts, so the Go engine
// stays current on its own rather than only through the TypeScript agent it is replacing.
//
// The policy is pure (Decide) and every rule is a branch, so each is a test rather than a comment;
// everything that touches the network or the package manager is injected, so a run is testable
// without either. Four refusals shape it: it never blocks the prompt (the check is bounded and its
// result read later), it never installs mid-turn (only at a decision point the caller names), it
// never runs under automation (a pipe, a headless run or CI checks and installs nothing), and a
// version that was declined or failed to install is never offered again on its own.
package update

import (
	"strconv"
	"strings"
	"time"
)

// Package is the npm package a release ships as; the registry is asked about this name.
const Package = "@archymedes/friday"

// Interval is how often to look: daily — often enough to matter, rare enough that nobody notices.
const Interval = 24 * time.Hour

// FetchTimeout bounds the registry check. A registry that cannot answer in this has nothing to say
// worth delaying a prompt for, and tomorrow's check costs nothing.
const FetchTimeout = 3 * time.Second

// Mode is how much the update may do on its own.
type Mode string

const (
	// Off never checks. Check looks and tells the person. Install looks and installs (the default).
	ModeOff     Mode = "off"
	ModeCheck   Mode = "check"
	ModeInstall Mode = "install"
)

// ReadMode reads ARCHYMEDES_AUTO_UPDATE. Unset is the product default (install). A malformed value
// fails safe to notification only, rather than silently granting install authority a person may
// have tried to deny.
func ReadMode(get func(string) string) Mode {
	switch strings.ToLower(strings.TrimSpace(get("ARCHYMEDES_AUTO_UPDATE"))) {
	case "off", "false", "0", "no":
		return ModeOff
	case "check", "notify":
		return ModeCheck
	case "install", "auto", "on", "true", "1", "yes":
		return ModeInstall
	case "":
		return ModeInstall
	default:
		return ModeCheck
	}
}

// State is what the last check left behind, kept in update-check.json.
type State struct {
	// LastCheckedAt is epoch ms of the last completed check, successful or not: looking still counts.
	LastCheckedAt int64 `json:"lastCheckedAt"`
	// LatestVersion is the newest version the registry reported, if the last check got an answer.
	LatestVersion string `json:"latestVersion,omitempty"`
	// SkippedVersion is a version that was declined or failed to install; never offered again on its own.
	SkippedVersion string `json:"skippedVersion,omitempty"`
}

// Action is what to do now.
type Action string

const (
	ActionSkip    Action = "skip"
	ActionCheck   Action = "check"
	ActionNotify  Action = "notify"
	ActionInstall Action = "install"
)

// Decision is an action and, for notify/install, the version it is about.
type Decision struct {
	Action  Action
	Version string
	Reason  string // for skip: disabled, not_interactive, ci, not_due
}

// Inputs is everything Decide needs and nothing it fetches.
type Inputs struct {
	Mode           Mode
	Interactive    bool // false for a pipe, a headless run, or anything with nobody watching
	CI             bool
	CurrentVersion string
	State          *State
	Now            time.Time
}

// Decide is what to do right now, given everything known and nothing fetched.
func Decide(in Inputs) Decision {
	if in.Mode == ModeOff {
		return Decision{Action: ActionSkip, Reason: "disabled"}
	}
	if !in.Interactive {
		return Decision{Action: ActionSkip, Reason: "not_interactive"}
	}
	if in.CI {
		return Decision{Action: ActionSkip, Reason: "ci"}
	}
	now := in.Now.UnixMilli()
	due := in.State == nil || now-in.State.LastCheckedAt >= Interval.Milliseconds() || in.State.LastCheckedAt > now
	// A known-newer version acts before a due check does: the answer is already in hand, and asking
	// the registry again to learn what was learned yesterday is a request nobody needed.
	if s := in.State; s != nil && s.LatestVersion != "" && s.LatestVersion != in.CurrentVersion && s.SkippedVersion != s.LatestVersion {
		if IsNewer(s.LatestVersion, in.CurrentVersion) {
			if in.Mode == ModeInstall {
				return Decision{Action: ActionInstall, Version: s.LatestVersion}
			}
			return Decision{Action: ActionNotify, Version: s.LatestVersion}
		}
	}
	if due {
		return Decision{Action: ActionCheck}
	}
	return Decision{Action: ActionSkip, Reason: "not_due"}
}

// IsNewer reports whether candidate is a later release than current. It is deliberately not a full
// semver comparison; it is the cheap guard that keeps a downgrade from ever being offered when a
// local build is ahead of the registry — the normal state while developing Friday itself, where
// the version is "dev" and parses to nothing, so nothing is ever newer than it.
func IsNewer(candidate, current string) bool {
	left, lok := releaseParts(candidate)
	right, rok := releaseParts(current)
	if !lok || !rok {
		return false
	}
	for i := 0; i < len(left) || i < len(right); i++ {
		l, r := at(left, i), at(right, i)
		if l != r {
			return l > r
		}
	}
	return false
}

// releaseParts is the dotted numbers before any pre-release suffix; ok is false if any is not a number.
func releaseParts(v string) ([]int, bool) {
	core := strings.SplitN(strings.TrimSpace(v), "-", 2)[0]
	if core == "" {
		return nil, false
	}
	fields := strings.Split(core, ".")
	out := make([]int, len(fields))
	for i, f := range fields {
		n, err := strconv.Atoi(f)
		if err != nil {
			return nil, false
		}
		out[i] = n
	}
	return out, true
}

func at(xs []int, i int) int {
	if i < len(xs) {
		return xs[i]
	}
	return 0
}

// notify is what the person sees when a newer version is found and installing is not enabled.
func notify(version, current string) []string {
	return []string{
		"Friday " + version + " is available — you are on " + current + ".",
		"Run `friday update` to install it, or turn on automatic updates in settings.",
	}
}

// installed is what the person sees after an automatic install. The running process is old code.
func installed(version string) []string {
	return []string{
		"Updated to Friday " + version + ".",
		"This session keeps running the version it started with; restart when convenient.",
	}
}
