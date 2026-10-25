// Package advise is what Friday suggests beside the work: next steps after a turn that changed
// code, notes on an edit, and the completion a request being typed is heading for. Code finds the
// candidates, from what the turn did and what the project has; the small model may add a couple of
// its own (ARCHYMEDES_SUGGEST_MODEL); Jev, TypeSafe's System One model, judges them when a key is
// set. Jev answers typed questions with probabilities and never writes text, so it only ever
// chooses among candidates that exist.
//
// Every part fails open and quietly: a suggestion is the least important thing on screen, so an
// unreachable judge, a slow model or a malformed answer means fewer suggestions, never an error.
// The TypeScript engine's Jev client (packages/core/src/cli/jev.ts) is the same contract.
package advise

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	// JevURL is TypeSafe's System One endpoint.
	JevURL = "https://api.typesafe.ai/v1/systemone"
	// JevDefaultModel is the model asked unless TYPESAFE_MODEL names another.
	JevDefaultModel = "jev-latest"
	// MaxState bounds what one question is asked about: a summary of the work, never a transcript.
	MaxState = 4000
)

// Question is one System One question: noul (is it so), choice (which one) or score (how much).
type Question struct {
	Type         string `json:"type"`
	Instructions string `json:"instructions"`
	Criteria     any    `json:"criteria,omitempty"`
}

// Answer is one answer; the fields its Type uses are set.
type Answer struct {
	Type          string             `json:"type"`
	Noul          float64            `json:"noul"`
	Choice        string             `json:"choice"`
	Confidence    float64            `json:"confidence"`
	Probabilities map[string]float64 `json:"probabilities"`
}

// Jev asks TypeSafe's System One model. A nil *Jev is no judge: every caller treats it so.
type Jev struct {
	key, model, url string
	client          *http.Client
}

// NewJev is the judge the settings ask for: nil without TYPESAFE_API_KEY, or with ARCHYMEDES_JEV
// set to off. get reads a setting (the environment over settings.json).
func NewJev(get func(string) string) *Jev {
	if strings.EqualFold(strings.TrimSpace(get("ARCHYMEDES_JEV")), "off") {
		return nil
	}
	key := strings.TrimSpace(get("TYPESAFE_API_KEY"))
	if key == "" {
		return nil
	}
	return &Jev{key: key, model: cmp.Or(strings.TrimSpace(get("TYPESAFE_MODEL")), JevDefaultModel), url: JevURL, client: &http.Client{}}
}

// Ask puts questions about state to Jev and returns its answers by question name. An answer that
// is missing or malformed is an error: a half-read probability is still a guess. The key never
// appears in an error.
func (j *Jev) Ask(ctx context.Context, timeout time.Duration, state any, questions map[string]Question) (map[string]Answer, error) {
	if j == nil {
		return nil, fmt.Errorf("no judge")
	}
	body, err := json.Marshal(map[string]any{"model": j.model, "state": state, "questions": questions})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, j.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+j.key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := j.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jev unreachable: %w", ctx.Err())
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jev answered %d", resp.StatusCode)
	}
	var out struct {
		Answers map[string]Answer `json:"answers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("jev answer unreadable: %w", err)
	}
	for name, q := range questions {
		a, ok := out.Answers[name]
		if !ok || a.Type != q.Type || !valid(a) {
			return nil, fmt.Errorf("jev answer %q missing or malformed", name)
		}
	}
	return out.Answers, nil
}

func valid(a Answer) bool {
	in := func(p float64) bool { return p >= 0 && p <= 1 }
	if a.Type == "noul" {
		return in(a.Noul)
	}
	for _, p := range a.Probabilities {
		if !in(p) {
			return false
		}
	}
	return len(a.Probabilities) > 0
}

// clip is s cut to n bytes on a rune boundary, marked when cut.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8Start(s[n]) {
		n--
	}
	return s[:n] + "…"
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }
