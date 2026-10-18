package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func env(values map[string]string) func(string) string {
	return func(k string) string { return values[k] }
}

func TestDirMatchesTheAgentsSettingsDirectory(t *testing.T) {
	cases := []struct {
		env  map[string]string
		goos string
		want string
	}{
		{map[string]string{"ARCHYMEDES_CONFIG_DIR": "/custom"}, "linux", "/custom"},
		{nil, "linux", "/home/u/.config/archymedes"},
		{map[string]string{"XDG_CONFIG_HOME": "/xdg"}, "linux", "/xdg/archymedes"},
		{nil, "darwin", "/home/u/Library/Application Support/Archymedes"},
		{map[string]string{"APPDATA": `/appdata`}, "windows", "/appdata/Archymedes"},
	}
	for _, c := range cases {
		if got := filepath.ToSlash(Dir(env(c.env), "/home/u", c.goos)); got != c.want {
			t.Errorf("%v %s: %s", c.env, c.goos, got)
		}
	}
}

func TestKeysRoundTripAndAMissingOrBrokenFileMeansDefaults(t *testing.T) {
	dir := t.TempDir()
	if keys, err := LoadKeys(dir); err != nil || len(keys) != 0 {
		t.Fatalf("missing file: %v %v", keys, err)
	}
	want := map[string][]string{"files": {"ctrl+e"}}
	if err := SaveKeys(dir, want); err != nil {
		t.Fatal(err)
	}
	if got, err := LoadKeys(dir); err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("%v %v", got, err)
	}
	os.WriteFile(filepath.Join(dir, KeysFile), []byte("{broken"), 0o600)
	if keys, err := LoadKeys(dir); err == nil || len(keys) != 0 {
		t.Fatal("a broken file is reported and means defaults")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != KeysFile {
			t.Fatalf("temporary file left behind: %s", e.Name())
		}
	}
}

func TestStateStartsUnwelcomedAndRemembers(t *testing.T) {
	dir := t.TempDir()
	if LoadState(dir).Welcomed {
		t.Fatal("a first run is not welcomed yet")
	}
	if err := SaveState(dir, State{Welcomed: true}); err != nil {
		t.Fatal(err)
	}
	if !LoadState(dir).Welcomed {
		t.Fatal("not remembered")
	}
}

func TestUpdateStateKeepsWhatItDoesNotTouch(t *testing.T) {
	dir := t.TempDir()
	if err := UpdateState(dir, func(s *State) { s.Welcomed = true }); err != nil {
		t.Fatal(err)
	}
	if err := UpdateState(dir, func(s *State) { s.Wallpaper = "off" }); err != nil {
		t.Fatal(err)
	}
	if got := LoadState(dir); !got.Welcomed || got.Wallpaper != "off" {
		t.Fatalf("state = %+v", got)
	}
}
