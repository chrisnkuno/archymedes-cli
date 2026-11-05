package update

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Ported from packages/friday-cli/src/platform/install-cue.test.ts (WS-50.5): the same anonymous
// cue, to the same counter, under the same consent.

var yes = map[string]string{"ARCHYMEDES_TELEMETRY": "on"}

type counter struct {
	status int
	err    error
	sent   []struct {
		url  string
		body map[string]any
		raw  string
	}
}

func (c *counter) post(_ context.Context, url string, body []byte) (int, error) {
	var parsed map[string]any
	_ = json.Unmarshal(body, &parsed)
	c.sent = append(c.sent, struct {
		url  string
		body map[string]any
		raw  string
	}{url, parsed, string(body)})
	return c.status, c.err
}

func cueOptions(t *testing.T, values map[string]string, c *counter) CueOptions {
	t.Helper()
	return CueOptions{Getenv: env(values), ConfigDir: t.TempDir(), Version: "3.9.0", OS: "linux", Arch: "amd64", Post: c.post}
}

func TestACueIsOwedForAnInstallAnUpdateAndNothingAfter(t *testing.T) {
	if got := cueFor("", "3.9.0", "linux", "amd64"); !reflect.DeepEqual(got, &Cue{"install", "3.9.0", "linux", "x64"}) {
		t.Fatalf("first run: %+v", got)
	}
	if got := cueFor("3.8.0", "3.9.0", "darwin", "arm64"); !reflect.DeepEqual(got, &Cue{"update", "3.9.0", "darwin", "arm64"}) {
		t.Fatalf("new version: %+v", got)
	}
	if got := cueFor("3.9.0", "3.9.0", "windows", "386"); got != nil {
		t.Fatalf("same version: %+v", got)
	}
	// The platform is named as Node names it, so the counter sees one platform whichever engine sent it.
	if got := cueFor("", "1", "windows", "386"); got.OS != "win32" || got.Arch != "ia32" {
		t.Fatalf("windows: %+v", got)
	}
}

func TestTheCueSendsFourFieldsOncePerVersion(t *testing.T) {
	c := &counter{status: 204}
	o := cueOptions(t, yes, c)
	if got := SendCue(context.Background(), o); got != CueSent {
		t.Fatalf("%s", got)
	}
	if CueURL != "https://archymedes.xyz/api/v1/count/" || len(c.sent) != 1 || c.sent[0].url != CueURL {
		t.Fatalf("sent %+v", c.sent)
	}
	if c.sent[0].raw != `{"event":"install","version":"3.9.0","os":"linux","arch":"x64"}` {
		t.Fatalf("payload %s: exactly what the TypeScript agent sent", c.sent[0].raw)
	}
	data, _ := os.ReadFile(filepath.Join(o.ConfigDir, "installed.json"))
	if string(data) != "{\"version\":\"3.9.0\"}\n" {
		t.Fatalf("marker %q", data)
	}
	if got := SendCue(context.Background(), o); got != CueOwedNone || len(c.sent) != 1 {
		t.Fatalf("second send: %s, %d sent", got, len(c.sent))
	}
	o.Version = "3.10.0"
	if got := SendCue(context.Background(), o); got != CueSent || c.sent[1].body["event"] != "update" {
		t.Fatalf("after an update: %s %+v", got, c.sent)
	}
}

func TestTheCueIsOffWhenAnyoneSaysNo(t *testing.T) {
	for _, values := range []map[string]string{{"ARCHYMEDES_TELEMETRY": "off"}, {"ARCHYMEDES_TELEMETRY": "0"}, {"DO_NOT_TRACK": "1"}, {"CI": "true"}, {"NODE_ENV": "test"},
		{"ARCHYMEDES_TELEMETRY": "on", "DO_NOT_TRACK": "1"}, {"ARCHYMEDES_TELEMETRY": "on", "CI": "true"}} {
		c := &counter{status: 204}
		if got := SendCue(context.Background(), cueOptions(t, values, c)); got != CueOptedOut || len(c.sent) != 0 {
			t.Errorf("%v: %s, %d sent", values, got, len(c.sent))
		}
	}
	if cueOptedOut(env(map[string]string{"DO_NOT_TRACK": "0", "ARCHYMEDES_TELEMETRY": "on"})) {
		t.Error("DO_NOT_TRACK=0 is not a no")
	}
}

func TestTheCueIsOffUntilThePersonSaysYes(t *testing.T) {
	for _, values := range []map[string]string{{}, {"ARCHYMEDES_TELEMETRY": ""}, {"ARCHYMEDES_TELEMETRY": "maybe"}} {
		c := &counter{status: 204}
		o := cueOptions(t, values, c)
		if got := SendCue(context.Background(), o); got != CueNoConsent || len(c.sent) != 0 {
			t.Errorf("%v: %s", values, got)
		}
		if _, err := os.Stat(filepath.Join(o.ConfigDir, "installed.json")); err == nil {
			t.Errorf("%v: a marker was written", values)
		}
	}
	for _, word := range []string{"on", "ON", "1", "true", "yes", " on "} {
		if !cueConsented(env(map[string]string{"ARCHYMEDES_TELEMETRY": word})) {
			t.Errorf("%q is a yes", word)
		}
	}
}

func TestTheCueRetriesAfterNoAnswerAndStopsAfterARefusal(t *testing.T) {
	marker := func(o CueOptions) bool {
		_, err := os.Stat(filepath.Join(o.ConfigDir, "installed.json"))
		return err == nil
	}
	down := &counter{status: 503}
	if o := cueOptions(t, yes, down); SendCue(context.Background(), o) != CueFailed || marker(o) {
		t.Error("a server error must leave the cue for the next run")
	}
	refused := &counter{status: 400}
	if o := cueOptions(t, yes, refused); SendCue(context.Background(), o) != CueSent || !marker(o) {
		t.Error("a refusal is final")
	}
	offline := &counter{err: errors.New("fetch failed")}
	if o := cueOptions(t, yes, offline); SendCue(context.Background(), o) != CueFailed || marker(o) {
		t.Error("no answer must leave the cue for the next run")
	}
}

func TestTheCueGoesWhereTheSettingSays(t *testing.T) {
	c := &counter{status: 200}
	SendCue(context.Background(), cueOptions(t, map[string]string{"ARCHYMEDES_TELEMETRY": "yes", "ARCHYMEDES_TELEMETRY_URL": " https://staging.example/count/ "}, c))
	if len(c.sent) != 1 || c.sent[0].url != "https://staging.example/count/" {
		t.Fatalf("%+v", c.sent)
	}
}
