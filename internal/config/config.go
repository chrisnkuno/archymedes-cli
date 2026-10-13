// Package config is where the Go interface keeps what a person changed: the same directory the
// agent's settings.json lives in (settingsDirectory in packages/archymedes-cli/src/platform/settings.ts),
// so both halves of the CLI share one place, each in its own file.
package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Dir is the config directory: ARCHYMEDES_CONFIG_DIR, else the platform's own place.
func Dir(getenv func(string) string, home string, goos string) string {
	if dir := strings.TrimSpace(getenv("ARCHYMEDES_CONFIG_DIR")); dir != "" {
		abs, err := filepath.Abs(dir)
		if err == nil {
			return abs
		}
		return dir
	}
	switch goos {
	case "windows":
		appData := strings.TrimSpace(getenv("APPDATA"))
		if appData == "" {
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appData, "Archymedes")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Archymedes")
	}
	xdg := strings.TrimSpace(getenv("XDG_CONFIG_HOME"))
	if xdg == "" {
		xdg = filepath.Join(home, ".config")
	}
	return filepath.Join(xdg, "archymedes")
}

// Default is Dir for this process.
func Default() string {
	home, _ := os.UserHomeDir()
	return Dir(os.Getenv, home, runtime.GOOS)
}

// KeysFile holds only the bindings someone changed: action id → keys.
const KeysFile = "keys.json"

// LoadKeys reads the changed bindings. A missing file is no changes; a broken one is reported so
// the caller can say so, and also means no changes — the defaults always work.
func LoadKeys(dir string) (map[string][]string, error) {
	data, err := os.ReadFile(filepath.Join(dir, KeysFile))
	if errors.Is(err, fs.ErrNotExist) {
		return map[string][]string{}, nil
	}
	if err != nil {
		return map[string][]string{}, err
	}
	keys := map[string][]string{}
	if err := json.Unmarshal(data, &keys); err != nil {
		return map[string][]string{}, err
	}
	return keys, nil
}

// SaveKeys writes the changed bindings atomically (a temporary file renamed into place), so a crash
// mid-write never leaves a half-written file that would discard every binding.
func SaveKeys(dir string, keys map[string][]string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(keys, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".keys-*.json")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, KeysFile))
}
