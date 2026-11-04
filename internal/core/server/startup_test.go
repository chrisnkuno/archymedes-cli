package server

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A newer version is already known (the hourly check found it). Startup runs while a session is
// open, so it must announce it and install nothing; with a TypeScript agent behind the engine, that
// agent is told the update is not its to run.
func TestStartupAnnouncesAnUpdateButNeverInstallsMidSession(t *testing.T) {
	dir := t.TempDir()
	state, _ := json.Marshal(map[string]any{"lastCheckedAt": time.Now().UnixMilli(), "latestVersion": "9.0.0"})
	if err := os.WriteFile(filepath.Join(dir, "update-check.json"), state, 0o644); err != nil {
		t.Fatal(err)
	}
	var forwardedMethod, forwardedParams string
	s := New(io.Discard, Options{
		ConfigDir: dir, Version: "1.0.0", Environ: []string{"ARCHYMEDES_AUTO_UPDATE=install"},
		Forward: func(_ context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
			forwardedMethod, forwardedParams = method, string(params)
			return json.RawMessage(`{"notices":["from the TypeScript agent"]}`), nil
		},
	})
	got, err := s.startup(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	notices := got.(map[string]any)["notices"].([]string)
	if len(notices) != 1 || !strings.Contains(notices[0], "9.0.0 is ready") {
		t.Fatalf("notices = %v: the engine announces the update, and the agent's own are not shown", notices)
	}
	if forwardedMethod != "_archymedes/startup" || !strings.Contains(forwardedParams, `"updates":false`) {
		t.Fatalf("forwarded %q %s: the agent must be told it does not own the update", forwardedMethod, forwardedParams)
	}
	var after struct {
		InstalledVersion string `json:"installedVersion"`
		Installing       string `json:"installing"`
	}
	data, _ := os.ReadFile(filepath.Join(dir, "update-check.json"))
	_ = json.Unmarshal(data, &after)
	if after.InstalledVersion != "" || after.Installing != "" {
		t.Fatalf("an install was started mid-session: %s", data)
	}
}
