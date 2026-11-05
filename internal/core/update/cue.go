package update

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// The install cue (WS-50.5, ported from packages/friday-cli/src/platform/install-cue.ts): one
// anonymous cue when a new version first runs, so installs and updates can be counted
// (archymedes.xyz, /api/v1/count/). What is sent is {event, version, os, arch} and nothing else: no
// id, no path, no project, no account. It is off until the person says yes (the first-run welcome,
// Settings, or ARCHYMEDES_TELEMETRY=on); a no stays a no (ARCHYMEDES_TELEMETRY=off, DO_NOT_TRACK),
// and it is never sent from CI or a test run. It never delays anything: the caller does not wait
// for it, the request gives up after two seconds, and a failure is retried on the next run.

// CueURL is the counter; ARCHYMEDES_TELEMETRY_URL points elsewhere (a staging counter).
const CueURL = "https://archymedes.xyz/api/v1/count/"

// cueTimeout bounds the request.
const cueTimeout = 2 * time.Second

// cueMarker, beside settings.json, holds the version the last cue was for.
const cueMarker = "installed.json"

// Cue is what is sent, in this field order.
type Cue struct {
	Event   string `json:"event"`
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// CueOutcome is what sending did.
type CueOutcome string

const (
	CueSent      CueOutcome = "sent"
	CueOwedNone  CueOutcome = "owed-none"
	CueOptedOut  CueOutcome = "opted-out"
	CueNoConsent CueOutcome = "no-consent"
	CueFailed    CueOutcome = "failed"
)

// CueOptions are what a send needs; Post is the network, injected for tests.
type CueOptions struct {
	Getenv    func(string) string
	ConfigDir string
	Version   string
	// OS and Arch are runtime.GOOS and runtime.GOARCH; they are sent as Node names them.
	OS, Arch string
	Post     func(ctx context.Context, url string, body []byte) (status int, err error)
}

// cueOptedOut: the person, or the place it runs, said no.
func cueOptedOut(get func(string) string) bool {
	telemetry := strings.ToLower(strings.TrimSpace(get("ARCHYMEDES_TELEMETRY")))
	if slices.Contains([]string{"off", "0", "false", "no"}, telemetry) {
		return true
	}
	if dnt := strings.TrimSpace(get("DO_NOT_TRACK")); dnt != "" && dnt != "0" && !strings.EqualFold(dnt, "false") {
		return true
	}
	// A CI machine reinstalls on every run, and a test run is not a person installing.
	return strings.TrimSpace(get("CI")) != "" || get("NODE_ENV") == "test"
}

// cueConsented: ARCHYMEDES_TELEMETRY is on, 1, true or yes. Unset is not a yes.
func cueConsented(get func(string) string) bool {
	return slices.Contains([]string{"on", "1", "true", "yes"}, strings.ToLower(strings.TrimSpace(get("ARCHYMEDES_TELEMETRY"))))
}

// nodeNames are Go's platform names as Node's process.platform and process.arch say them, so the
// counter sees one platform whichever engine sent the cue.
var nodeNames = map[string]string{"windows": "win32", "amd64": "x64", "386": "ia32"}

func nodeName(goName string) string {
	if n, ok := nodeNames[goName]; ok {
		return n
	}
	return goName
}

// cueFor is the cue this run owes, given the version the last one was for; nil when none.
func cueFor(last, version, goos, goarch string) *Cue {
	if last == version {
		return nil
	}
	event := "install"
	if last != "" {
		event = "update"
	}
	return &Cue{Event: event, Version: version, OS: nodeName(goos), Arch: nodeName(goarch)}
}

// SendCue sends the cue this run owes. The marker is written once the counter answered: any status
// below 500 (a 4xx is a refusal for good, so retrying cannot help). No answer or a 5xx leaves it
// for the next run.
func SendCue(ctx context.Context, o CueOptions) CueOutcome {
	if cueOptedOut(o.Getenv) {
		return CueOptedOut
	}
	if !cueConsented(o.Getenv) {
		return CueNoConsent
	}
	file := filepath.Join(o.ConfigDir, cueMarker)
	last := ""
	if data, err := os.ReadFile(file); err == nil {
		var marker struct {
			Version any `json:"version"`
		}
		if json.Unmarshal(data, &marker) == nil {
			last, _ = marker.Version.(string)
		}
	}
	cue := cueFor(last, o.Version, o.OS, o.Arch)
	if cue == nil {
		return CueOwedNone
	}
	body, _ := json.Marshal(cue)
	url := strings.TrimSpace(o.Getenv("ARCHYMEDES_TELEMETRY_URL"))
	if url == "" {
		url = CueURL
	}
	post := o.Post
	if post == nil {
		post = PostJSON
	}
	ctx, cancel := context.WithTimeout(ctx, cueTimeout)
	defer cancel()
	status, err := post(ctx, url, body)
	if err != nil || status >= 500 {
		return CueFailed
	}
	if os.MkdirAll(o.ConfigDir, 0o700) == nil {
		marker, _ := json.Marshal(map[string]string{"version": o.Version})
		_ = os.WriteFile(file, append(marker, '\n'), 0o600)
	}
	return CueSent
}

// PostJSON posts body as JSON and says the status.
func PostJSON(ctx context.Context, url string, body []byte) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}
