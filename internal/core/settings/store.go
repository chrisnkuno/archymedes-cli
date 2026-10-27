package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// FileName is settings.json, in the config directory (internal/config.Dir).
const FileName = "settings.json"

// File is where the settings are kept.
func File(dir string) string { return filepath.Join(dir, FileName) }

// Load reads the stored settings: known keys with a value, trimmed. A missing or broken file is
// no settings; a change is refused over a broken one (read).
func Load(dir string) map[string]string {
	values, _ := read(dir)
	return values
}

// read is Load that says why a file that exists could not be used, so that saving never replaces a
// file someone broke by hand (and every key in it) with one setting.
func read(dir string) (map[string]string, error) {
	data, err := os.ReadFile(File(dir))
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return map[string]string{}, err
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return map[string]string{}, err
	}
	return clean(raw), nil
}

func clean(raw map[string]any) map[string]string {
	out := map[string]string{}
	keep := func(key string) {
		if s, ok := raw[key].(string); ok && strings.TrimSpace(s) != "" {
			out[key] = strings.TrimSpace(s)
		}
	}
	for _, f := range Fields {
		keep(f.Key)
	}
	for _, key := range Internal {
		keep(key)
	}
	return out
}

// Save writes values (unknown keys dropped) readable by this user only, replacing the file in
// one rename so a crash never leaves half of it. It returns the file's path.
func Save(dir string, values map[string]string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	raw := map[string]any{}
	for k, v := range values {
		raw[k] = v
	}
	cleaned := clean(raw)
	// Saved in the Settings list's order, internal keys last, as the TypeScript agent wrote it.
	var b strings.Builder
	b.WriteString("{")
	first := true
	write := func(key string) {
		v, ok := cleaned[key]
		if !ok {
			return
		}
		if !first {
			b.WriteString(",")
		}
		first = false
		k, _ := json.Marshal(key)
		val, _ := json.Marshal(v)
		fmt.Fprintf(&b, "\n  %s: %s", k, val)
	}
	for _, f := range Fields {
		write(f.Key)
	}
	for _, key := range Internal {
		write(key)
	}
	if !first {
		b.WriteString("\n")
	}
	b.WriteString("}\n")

	file := File(dir)
	// A temporary name of its own, so two saves never write into one file.
	tmp, err := os.CreateTemp(dir, FileName+".*.tmp")
	if err != nil {
		return "", err
	}
	_, err = tmp.WriteString(b.String())
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o600)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), file)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	return file, nil
}

// fromEnvironment is the value environ sets for key, "" when it sets none.
func fromEnvironment(environ []string, key string) string {
	for _, kv := range slices.Backward(environ) {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			return v
		}
	}
	return ""
}
