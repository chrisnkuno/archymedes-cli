package server

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// noForward fails the test when anything reaches the TypeScript agent.
func noForward(t *testing.T) Forwarder {
	return func(_ context.Context, method string, _ json.RawMessage) (json.RawMessage, error) {
		t.Errorf("%s was forwarded to the TypeScript agent", method)
		return nil, nil
	}
}

// A newer version is already known (the hourly check found it). Startup runs while a session is
// open, so it must announce it and install nothing, and it asks the TypeScript agent nothing
// (WS-50.5): its upkeep is the engine's own.
func TestStartupAnnouncesAnUpdateButNeverInstallsMidSession(t *testing.T) {
	dir := t.TempDir()
	state, _ := json.Marshal(map[string]any{"lastCheckedAt": time.Now().UnixMilli(), "latestVersion": "9.0.0"})
	if err := os.WriteFile(filepath.Join(dir, "update-check.json"), state, 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(io.Discard, Options{ConfigDir: dir, Version: "1.0.0", Environ: []string{"ARCHYMEDES_AUTO_UPDATE=install", "ARCHYMEDES_TELEMETRY=off"}, Forward: noForward(t)})
	got, err := s.startup(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	notices := got.(map[string]any)["notices"].([]string)
	if len(notices) != 1 || !strings.Contains(notices[0], "9.0.0 is ready") {
		t.Fatalf("notices = %v", notices)
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

// TestStartupSendsTheInstallCueOnceAndNeverFromADevBuild: the cue the TypeScript agent sent when it
// started is the engine's now, once per process (startup runs hourly), with the same payload.
func TestStartupSendsTheInstallCueOnceAndNeverFromADevBuild(t *testing.T) {
	var mu sync.Mutex
	var sent []string
	arrived := make(chan struct{}, 4)
	post := func(_ context.Context, url string, body []byte) (int, error) {
		mu.Lock()
		sent = append(sent, url+" "+string(body))
		mu.Unlock()
		arrived <- struct{}{}
		return 204, nil
	}
	for _, version := range []string{"dev", ""} {
		s := New(io.Discard, Options{ConfigDir: t.TempDir(), Version: version, Environ: []string{"ARCHYMEDES_AUTO_UPDATE=off", "ARCHYMEDES_TELEMETRY=on"}, Post: post, Forward: noForward(t)})
		_, _ = s.startup(context.Background(), nil)
	}
	s := New(io.Discard, Options{ConfigDir: t.TempDir(), Version: "3.9.0", Environ: []string{"ARCHYMEDES_AUTO_UPDATE=off", "ARCHYMEDES_TELEMETRY=on"}, Post: post, Forward: noForward(t)})
	for range 3 {
		if _, err := s.startup(context.Background(), nil); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("no cue was sent")
	}
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 1 || !strings.HasPrefix(sent[0], "https://archymedes.xyz/api/v1/count/ ") || !strings.Contains(sent[0], `"version":"3.9.0"`) || !strings.Contains(sent[0], `"event":"install"`) {
		t.Fatalf("sent %v", sent)
	}
}
