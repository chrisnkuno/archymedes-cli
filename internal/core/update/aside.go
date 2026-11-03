package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Moving the running program aside, so an install can replace it. Windows locks a running
// executable against being overwritten or deleted, but lets it be renamed, even to another folder
// on the same drive. So before the package manager writes the new version, the running friday.exe
// is moved out of the package's folder, and both of Friday's processes run on from the moved file.
// A failed install moves it back. The moved copies are deleted at a later start, once nothing runs
// them (a delete of one still running simply fails, and is tried again next time).

// asideName marks a moved executable, so clearAside deletes only what setAside made.
const asideName = "friday-replaced-"

// asideDirs are where to move it, in order: beside the outermost node_modules (the same drive as the
// install, so the rename always works, and outside any package), then Friday's config folder.
func asideDirs(exe, configDir string) []string {
	var dirs []string
	// The outermost node_modules is the global one. The nearest is usually the package's own nested
	// folder, which the install is about to remove and which cannot go while the moved program runs.
	outer := ""
	for dir := filepath.Dir(exe); dir != filepath.Dir(dir); dir = filepath.Dir(dir) {
		if filepath.Base(dir) == "node_modules" {
			outer = dir
		}
	}
	if outer != "" {
		dirs = append(dirs, filepath.Join(outer, ".friday-replaced"))
	}
	if configDir != "" {
		dirs = append(dirs, filepath.Join(configDir, "update", "replaced"))
	}
	return dirs
}

// setAside moves exe aside and returns how to move it back.
func setAside(exe, configDir string, now time.Time) (func(), error) {
	if exe == "" {
		var err error
		if exe, err = os.Executable(); err != nil {
			return nil, err
		}
	}
	var last error = fmt.Errorf("nowhere to move %s", exe)
	for _, dir := range asideDirs(exe, configDir) {
		if os.MkdirAll(dir, 0o755) != nil {
			continue
		}
		moved := filepath.Join(dir, fmt.Sprintf("%s%d%s", asideName, now.UnixNano(), filepath.Ext(exe)))
		if last = os.Rename(exe, moved); last == nil {
			return func() { _ = os.Rename(moved, exe) }, nil
		}
	}
	return nil, last
}

// clearAside deletes what earlier updates moved aside, best effort.
func clearAside(exe, configDir string) {
	if exe == "" {
		exe, _ = os.Executable()
	}
	for _, dir := range asideDirs(exe, configDir) {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), asideName) {
				_ = os.Remove(filepath.Join(dir, e.Name())) // still running: fails, tried next time
			}
		}
	}
}
