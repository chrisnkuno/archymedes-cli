package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func env(pairs map[string]string) func(string) string {
	return func(k string) string { return pairs[k] }
}

func TestReadModeReadsTheSetting(t *testing.T) {
	cases := map[string]Mode{
		"": ModeInstall, "install": ModeInstall, "auto": ModeInstall, "on": ModeInstall, "1": ModeInstall,
		"check": ModeCheck, "notify": ModeCheck,
		"off": ModeOff, "false": ModeOff, "no": ModeOff,
		"nonsense": ModeCheck, // a malformed value fails safe to notify, not install
	}
	for raw, want := range cases {
		if got := ReadMode(env(map[string]string{"ARCHYMEDES_AUTO_UPDATE": raw})); got != want {
			t.Errorf("ReadMode(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestIsNewerNeverOffersADowngradeOrTouchesADevBuild(t *testing.T) {
	cases := []struct {
		candidate, current string
		want               bool
	}{
		{"3.12.2", "3.12.1", true},
		{"3.13.0", "3.12.9", true},
		{"3.12.1", "3.12.1", false},
		{"3.12.0", "3.12.1", false},
		{"4.0.0", "dev", false},        // a local dev build is never behind the registry
		{"dev", "3.12.1", false},       // and a bad registry answer is never newer
		{"3.12.2", "3.12.2-rc", false}, // pre-release suffixes are ignored, so these compare equal
	}
	for _, c := range cases {
		if got := IsNewer(c.candidate, c.current); got != c.want {
			t.Errorf("IsNewer(%q, %q) = %v, want %v", c.candidate, c.current, got, c.want)
		}
	}
}

func TestDecideFollowsThePolicy(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	recent := now.Add(-10 * time.Minute).UnixMilli()
	stale := now.Add(-48 * time.Hour).UnixMilli()
	newer := &State{LastCheckedAt: recent, LatestVersion: "2.0.0"}

	cases := []struct {
		name string
		in   Inputs
		want Action
	}{
		{"off", Inputs{Mode: ModeOff, Interactive: true, CurrentVersion: "1.0.0", Now: now}, ActionSkip},
		{"not interactive", Inputs{Mode: ModeInstall, Interactive: false, CurrentVersion: "1.0.0", Now: now}, ActionSkip},
		{"ci", Inputs{Mode: ModeInstall, Interactive: true, CI: true, CurrentVersion: "1.0.0", Now: now}, ActionSkip},
		{"due with no state", Inputs{Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", Now: now}, ActionCheck},
		{"stale is due", Inputs{Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", State: &State{LastCheckedAt: stale}, Now: now}, ActionCheck},
		{"known newer installs", Inputs{Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", State: newer, Now: now}, ActionInstall},
		{"known newer notifies in check mode", Inputs{Mode: ModeCheck, Interactive: true, CurrentVersion: "1.0.0", State: newer, Now: now}, ActionNotify},
		{"recent and current is not due", Inputs{Mode: ModeInstall, Interactive: true, CurrentVersion: "2.0.0", State: newer, Now: now}, ActionSkip},
		{"an hour on, a check is due", Inputs{Mode: ModeInstall, Interactive: true, CurrentVersion: "2.0.0", State: &State{LastCheckedAt: now.Add(-time.Hour).UnixMilli(), LatestVersion: "2.0.0"}, Now: now}, ActionCheck},
		{"an installed version waiting for a restart is not installed again", Inputs{Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", State: &State{LastCheckedAt: recent, LatestVersion: "2.0.0", InstalledVersion: "2.0.0"}, Now: now}, ActionSkip},
		{"a skipped version is not re-offered", Inputs{Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", State: &State{LastCheckedAt: recent, LatestVersion: "2.0.0", SkippedVersion: "2.0.0"}, Now: now}, ActionSkip},
	}
	for _, c := range cases {
		if got := Decide(c.in); got.Action != c.want {
			t.Errorf("%s: Decide = %q, want %q", c.name, got.Action, c.want)
		}
	}
}

func TestInstallArgvIsTheRightGlobalInstall(t *testing.T) {
	cases := map[Manager]string{
		NPM:  "npm install --global @archymedes/friday@3.12.2",
		PNPM: "pnpm add --global @archymedes/friday@3.12.2",
		Yarn: "yarn global add @archymedes/friday@3.12.2",
		Bun:  "bun add --global @archymedes/friday@3.12.2",
	}
	for m, want := range cases {
		name, args := InstallArgv(m, Package, "3.12.2")
		if got := name + " " + strings.Join(args, " "); got != want {
			t.Errorf("%s: %q, want %q", m, got, want)
		}
	}
}

func TestDetectManagerReadsTheOverrideThenTheClues(t *testing.T) {
	if m := DetectManager(env(map[string]string{"ARCHYMEDES_PACKAGE_MANAGER": "pnpm"}), "/usr/bin/node"); m != PNPM {
		t.Errorf("override = %q, want pnpm", m)
	}
	if m := DetectManager(env(map[string]string{"npm_config_user_agent": "yarn/1.22 node/20"}), "/usr/bin/node"); m != Yarn {
		t.Errorf("user-agent = %q, want yarn", m)
	}
	if m := DetectManager(env(nil), "/home/me/.bun/bin/friday"); m != Bun {
		t.Errorf("path clue = %q, want bun", m)
	}
	if m := DetectManager(env(nil), "/usr/local/bin/friday"); m != NPM {
		t.Errorf("default = %q, want npm", m)
	}
}

func TestRunInstallsAKnownNewerVersionWithoutFetching(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeState(dir, &State{LastCheckedAt: now.UnixMilli(), LatestVersion: "9.0.0"})
	var installed string
	notices := Run(context.Background(), Options{
		Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", ConfigDir: dir, Getenv: env(nil), Now: now,
		Fetch: func(context.Context, func(string) string, string) (string, error) {
			t.Fatal("should not fetch")
			return "", nil
		},
		Do: func(_ context.Context, _ func(string) string, _, v string) bool { installed = v; return true },
	})
	if installed != "9.0.0" {
		t.Fatalf("installed %q, want 9.0.0", installed)
	}
	if !strings.Contains(strings.Join(notices, "\n"), "Friday 9.0.0 is installed; restart Friday to use it") {
		t.Fatalf("notice = %v", notices)
	}
}

func TestRunChecksThenNotifiesInCheckMode(t *testing.T) {
	dir := t.TempDir()
	notices := Run(context.Background(), Options{
		Mode: ModeCheck, Interactive: true, CurrentVersion: "1.0.0", ConfigDir: dir, Getenv: env(nil),
		Fetch: func(context.Context, func(string) string, string) (string, error) { return "2.0.0", nil },
		Do: func(context.Context, func(string) string, string, string) bool {
			t.Fatal("check mode never installs")
			return false
		},
	})
	if !strings.Contains(strings.Join(notices, "\n"), "Friday 2.0.0 is available") {
		t.Fatalf("notice = %v", notices)
	}
	if s := readState(dir); s == nil || s.LatestVersion != "2.0.0" {
		t.Fatalf("state not stamped with the latest: %+v", s)
	}
}

func TestRunStampsTheCheckEvenWhenTheRegistryIsUnreachable(t *testing.T) {
	dir := t.TempDir()
	notices := Run(context.Background(), Options{
		Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", ConfigDir: dir, Getenv: env(nil),
		Fetch: func(context.Context, func(string) string, string) (string, error) { return "", errors.New("offline") },
	})
	if len(notices) != 0 {
		t.Fatalf("an unreachable registry said %v", notices)
	}
	if s := readState(dir); s == nil || s.LastCheckedAt <= 0 || s.LatestVersion != "" {
		t.Fatalf("the check was not stamped: %+v", s)
	}
}

func TestRunRemembersAFailedInstallAsSkipped(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeState(dir, &State{LastCheckedAt: now.UnixMilli(), LatestVersion: "9.0.0"})
	notices := Run(context.Background(), Options{
		Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", ConfigDir: dir, Getenv: env(nil), Now: now,
		Do: func(context.Context, func(string) string, string, string) bool { return false },
	})
	if !strings.Contains(strings.Join(notices, "\n"), "Could not install Friday 9.0.0") {
		t.Fatalf("notice = %v", notices)
	}
	if s := readState(dir); s == nil || s.SkippedVersion != "9.0.0" {
		t.Fatalf("the failed version was not remembered as skipped: %+v", s)
	}
	// A second round offers it no more.
	again := Run(context.Background(), Options{
		Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", ConfigDir: dir, Getenv: env(nil), Now: now,
		Do: func(context.Context, func(string) string, string, string) bool {
			t.Fatal("a skipped version was offered again")
			return false
		},
	})
	if len(again) != 0 {
		t.Fatalf("second round said %v", again)
	}
}

func TestRunDoesNothingUnderAutomation(t *testing.T) {
	notices := Run(context.Background(), Options{
		Mode: ModeInstall, Interactive: false, CurrentVersion: "1.0.0", ConfigDir: t.TempDir(), Getenv: env(nil),
		Fetch: func(context.Context, func(string) string, string) (string, error) {
			t.Fatal("a non-interactive run must not check")
			return "", nil
		},
	})
	if len(notices) != 0 {
		t.Fatalf("a non-interactive run said %v", notices)
	}
}

func TestRunInstallsOnceAndKeepsWhatItInstalled(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeState(dir, &State{LastCheckedAt: now.UnixMilli(), LatestVersion: "9.0.0"})
	installs := 0
	o := Options{
		Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", ConfigDir: dir, Getenv: env(nil), Now: now,
		Fetch: func(context.Context, func(string) string, string) (string, error) { return "9.0.0", nil },
		Do:    func(context.Context, func(string) string, string, string) bool { installs++; return true },
	}
	Run(context.Background(), o)
	o.Now = now.Add(2 * time.Hour) // the next hourly check, still running 1.0.0
	if notices := Run(context.Background(), o); installs != 1 || len(notices) != 0 {
		t.Fatalf("installed %d times, notices %v: an installed version waits for the restart", installs, notices)
	}
	if s := readState(dir); s == nil || s.InstalledVersion != "9.0.0" {
		t.Fatalf("state = %+v", s)
	}
}

// TestWindowsMovesTheRunningProgramAsideAndBack: the install replaces a program that is not where
// it was; a failed install puts it back; a later start deletes what was moved.
func TestWindowsMovesTheRunningProgramAsideAndBack(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "npm", "node_modules", "@archymedes", "friday-win32-x64", "bin", "friday.exe")
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	put := func() { _ = os.WriteFile(exe, []byte("old friday"), 0o755) }
	put()
	dir := t.TempDir()
	now := time.Now()
	writeState(dir, &State{LastCheckedAt: now.UnixMilli(), LatestVersion: "9.0.0"})
	var during bool
	o := Options{
		Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", ConfigDir: dir, Getenv: env(nil), Now: now,
		MoveAside: true, Executable: exe,
		Do: func(context.Context, func(string) string, string, string) bool {
			_, err := os.Stat(exe)
			during = os.IsNotExist(err)
			return false // the install fails
		},
	}
	Run(context.Background(), o)
	if !during {
		t.Fatal("the running program was still in the package while it was being replaced")
	}
	if data, err := os.ReadFile(exe); err != nil || string(data) != "old friday" {
		t.Fatalf("a failed install puts the program back: %q %v", data, err)
	}

	// A good install: moved aside, then cleared at a later start.
	writeState(dir, &State{LastCheckedAt: now.UnixMilli(), LatestVersion: "9.1.0"})
	o.Do = func(context.Context, func(string) string, string, string) bool { put(); return true } // npm writes the new one
	Run(context.Background(), o)
	aside := filepath.Join(root, "npm", "node_modules", ".friday-replaced")
	if entries, _ := os.ReadDir(aside); len(entries) != 1 {
		t.Fatalf("the old program waits beside node_modules: %v", entries)
	}
	clearAside(exe, dir)
	if entries, _ := os.ReadDir(aside); len(entries) != 0 {
		t.Fatalf("a later start deletes it: %v", entries)
	}
}

// TestAsideGoesBesideTheOutermostNodeModules: in a global npm install the program sits under the
// package's own nested node_modules, which the install removes; the moved copy must live outside it.
func TestAsideGoesBesideTheOutermostNodeModules(t *testing.T) {
	exe := filepath.Join("prefix", "node_modules", "@archymedes", "friday", "node_modules", "@archymedes", "friday-win32-x64", "bin", "friday.exe")
	got := asideDirs(exe, "")
	want := filepath.Join("prefix", "node_modules", ".friday-replaced")
	if len(got) != 1 || got[0] != want {
		t.Fatalf("asideDirs = %v, want [%s]", got, want)
	}
}

// TestAnInstallThatWroteElsewhereIsNotASuccess: the package manager exits 0 but nothing is at the
// launch path, so the old program goes back and the update counts as failed.
func TestAnInstallThatWroteElsewhereIsNotASuccess(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "node_modules", "@archymedes", "friday-win32-x64", "bin", "friday.exe")
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(exe, []byte("old friday"), 0o755)
	dir := t.TempDir()
	now := time.Now()
	writeState(dir, &State{LastCheckedAt: now.UnixMilli(), LatestVersion: "9.0.0"})
	o := Options{
		Mode: ModeInstall, Interactive: true, CurrentVersion: "1.0.0", ConfigDir: dir, Getenv: env(nil), Now: now,
		MoveAside: true, Executable: exe,
		Do: func(context.Context, func(string) string, string, string) bool { return true }, // exits 0, writes nothing here
	}
	Run(context.Background(), o)
	if data, err := os.ReadFile(exe); err != nil || string(data) != "old friday" {
		t.Fatalf("the old program is back: %q %v", data, err)
	}
	if s := readState(dir); s == nil || s.InstalledVersion == "9.0.0" {
		t.Fatalf("state = %+v: a phantom install must not be recorded", s)
	}
}
