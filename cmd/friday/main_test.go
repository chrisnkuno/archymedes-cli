package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/update"
)

func TestAgentCommandAcceptsAJSONArraySoPathsMayHoldSpaces(t *testing.T) {
	got, err := agentCommand(`["C:\\Program Files\\nodejs\\node.exe","C:\\npm\\@archymedes\\friday\\dist\\friday.mjs"]`, "")
	if err != nil || !reflect.DeepEqual(got, []string{`C:\Program Files\nodejs\node.exe`, `C:\npm\@archymedes\friday\dist\friday.mjs`}) {
		t.Fatalf("%q %v", got, err)
	}
	if got, _ := agentCommand("bun run x.ts", ""); !reflect.DeepEqual(got, []string{"bun", "run", "x.ts"}) {
		t.Fatalf("%q", got)
	}
	if _, err := agentCommand(`["unterminated`, ""); err == nil {
		t.Fatal("a malformed array is an error, not a command")
	}
}

func TestPhotosAreOnUnlessSaidOtherwise(t *testing.T) {
	for value, off := range map[string]bool{"": false, "on": false, "off": true, "OFF": true, "0": true, "false": true, "no": true, " off ": true} {
		if photosOff(value) != off {
			t.Errorf("ARCHYMEDES_PHOTOS=%q: off=%v", value, !off)
		}
	}
}

// A development checkout runs its own agent from source, wherever in the tree it is started.
func TestAgentCommandFindsTheCheckoutsOwnAgent(t *testing.T) {
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("bun is not installed")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	got, err := agentCommand("", filepath.Join(root, "internal", "tui"))
	want := filepath.Join(root, "packages", "friday-cli", "src", "friday.ts")
	if err != nil || len(got) != 3 || got[2] != want {
		t.Fatalf("agentCommand = %q, %v; want bun run %s", got, err, want)
	}
}

// A person who saved ARCHYMEDES_AUTO_UPDATE=off in Settings must not be updated when Friday closes:
// the exit install reads the same saved settings as the in-session check, with the environment over them.
func TestTheExitUpdateHonoursASavedSetting(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"ARCHYMEDES_AUTO_UPDATE":"off"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := exitUpdateOptions(dir, nil).Mode; got != update.ModeOff {
		t.Fatalf("saved off, mode = %q", got)
	}
	if got := exitUpdateOptions(dir, []string{"ARCHYMEDES_AUTO_UPDATE=check"}).Mode; got != update.ModeCheck {
		t.Fatalf("the environment wins over the saved setting, mode = %q", got)
	}
	if got := exitUpdateOptions(t.TempDir(), nil).Mode; got != update.ModeInstall {
		t.Fatalf("nothing saved, mode = %q", got)
	}
}
