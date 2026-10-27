package settings

import (
	"strings"
	"sync"
)

// Row is one setting as the interface draws it (`_archymedes/settings/list`).
type Row struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Section string   `json:"section"`
	Kind    string   `json:"kind"` // choice, text or secret
	Choices []Choice `json:"choices,omitempty"`
	// Value is what is stored, masked for a secret; "" when unset.
	Value string `json:"value"`
	IsSet bool   `json:"isSet"`
	// OverriddenByEnvironment: a variable in the environment wins, so editing here changes nothing visible.
	OverriddenByEnvironment bool `json:"overriddenByEnvironment"`
}

// Listing is the whole list and the file it is kept in.
type Listing struct {
	File string `json:"file"`
	Rows []Row  `json:"rows"`
}

// List is every setting with its stored value. themes are the interface's themes, offered for
// ARCHYMEDES_THEME; without them the theme is typed.
func List(dir string, environ []string, themes []Choice) Listing {
	stored := Load(dir)
	rows := make([]Row, 0, len(Fields))
	for _, f := range Fields {
		choices := f.Choices
		if f.Themes {
			choices = themes
		}
		kind := "text"
		switch {
		case f.Secret:
			kind = "secret"
		case len(choices) > 0:
			kind = "choice"
		}
		value := stored[f.Key]
		shown := value
		if f.Secret && value != "" {
			shown = Mask(value)
		}
		env := fromEnvironment(environ, f.Key)
		section := SectionOf(f.Key)
		if section == "" {
			section = "General"
		}
		rows = append(rows, Row{
			Key: f.Key, Label: f.Label, Section: section, Kind: kind, Choices: choices,
			Value: shown, IsSet: value != "", OverriddenByEnvironment: env != "" && env != value,
		})
	}
	return Listing{File: File(dir), Rows: rows}
}

// SetResult is what saving one setting did (`_archymedes/settings/set`).
type SetResult struct {
	OK    bool   `json:"ok"`
	File  string `json:"file,omitempty"`
	Value string `json:"value"`
	IsSet bool   `json:"isSet"`
	Error string `json:"error,omitempty"`
}

// saving keeps a change's read and write together: requests are answered concurrently, and two
// saves interleaved would each write the file as it was before the other.
var saving sync.Mutex

// Set saves one setting; an empty value clears it. A refusal comes back as Error, never as a Go error.
func Set(dir, key, raw string) SetResult {
	field, ok := Lookup(key)
	if !ok {
		name := key
		if name == "" {
			name = "(none)"
		}
		return SetResult{Error: "No setting named " + name + "."}
	}
	saving.Lock()
	defer saving.Unlock()
	values, err := read(dir)
	if err != nil {
		return SetResult{Error: "Could not read " + File(dir) + " (" + err.Error() + "). Fix or remove it, then try again; nothing was saved."}
	}
	stored := ""
	if strings.TrimSpace(raw) == "" {
		delete(values, key)
	} else {
		value, refusal := Validate(key, raw)
		if refusal != "" {
			return SetResult{Error: refusal}
		}
		stored = value
		values[key] = value
	}
	file, err := Save(dir, values)
	if err != nil {
		return SetResult{Error: "Could not save: " + err.Error()}
	}
	shown := stored
	if field.Secret && stored != "" {
		shown = Mask(stored)
	}
	return SetResult{OK: true, File: file, Value: shown, IsSet: stored != ""}
}
