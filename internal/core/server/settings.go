package server

import (
	"encoding/json"

	"github.com/chrisnkuno/friday-cli/internal/core/settings"
)

// settingsList answers `_archymedes/settings/list`: the Settings list as data, for the interface to draw.
func (s *Server) settingsList() settings.Listing {
	return settings.List(s.opts.ConfigDir, s.opts.Environ, s.opts.Themes)
}

// settingsSet answers `_archymedes/settings/set`. The next session reads the file again, so a
// saved value applies from then on.
func (s *Server) settingsSet(params json.RawMessage) settings.SetResult {
	var p struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	}
	_ = json.Unmarshal(params, &p)
	value, _ := p.Value.(string) // anything but text clears the setting, as the TypeScript agent did
	return settings.Set(s.opts.ConfigDir, p.Key, value)
}
