package llm

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// What OpenRouter says about the person's own key, GET /api/v1/key (openrouter-key-info.ts;
// WS-50.3). The key goes only to that fixed host as the bearer, and appears in no result.

// OpenRouterKeyURL is where a key is checked.
const OpenRouterKeyURL = FreeBaseURL + "/key"

// KeyInfo is the documented `{data:{…}}` body, field by field; nil fields were not reported.
type KeyInfo struct {
	Label             string     `json:"label,omitempty"`
	Limit             *float64   `json:"limit,omitempty"`
	LimitRemaining    *float64   `json:"limitRemaining,omitempty"`
	Usage             *float64   `json:"usage,omitempty"`
	IsFreeTier        *bool      `json:"isFreeTier,omitempty"`
	FreeDailyRequests *DailyFree `json:"freeDailyRequests,omitempty"`
}

// DailyFree is the current UTC day's free-model requests.
type DailyFree struct {
	Used      *int64 `json:"used,omitempty"`
	Limit     *int64 `json:"limit,omitempty"`
	Remaining *int64 `json:"remaining,omitempty"`
}

func finite(v any) *float64 {
	f, ok := v.(float64)
	if !ok || math.IsInf(f, 0) || math.IsNaN(f) || f < 0 {
		return nil
	}
	return &f
}

func count(v any) *int64 {
	f := finite(v)
	if f == nil || *f != math.Trunc(*f) || *f > 9007199254740991 {
		return nil
	}
	n := int64(*f)
	return &n
}

// ParseKeyInfo reads the body; nil when it is not the documented shape.
func ParseKeyInfo(body any) *KeyInfo {
	row, ok := object(body)["data"].(map[string]any)
	if !ok {
		return nil
	}
	info := &KeyInfo{Limit: finite(row["limit"]), LimitRemaining: finite(row["limit_remaining"]), Usage: finite(row["usage"])}
	if s, ok := row["label"].(string); ok && strings.TrimSpace(s) != "" {
		s = controlChars.ReplaceAllString(s, "")
		if r := []rune(s); len(r) > 80 {
			s = string(r[:80])
		}
		info.Label = s
	}
	if b, ok := row["is_free_tier"].(bool); ok {
		info.IsFreeTier = &b
	}
	daily := object(row["free_model_daily_requests"])
	used, limit, remaining := count(daily["used"]), count(daily["limit"]), count(daily["remaining"])
	if remaining == nil && used != nil && limit != nil {
		r := max(0, *limit-*used)
		remaining = &r
	}
	if used != nil || limit != nil || remaining != nil {
		info.FreeDailyRequests = &DailyFree{Used: used, Limit: limit, Remaining: remaining}
	}
	return info
}

// KeyCheck is a check's outcome: OK, or why not (invalid, network, error) with the status.
type KeyCheck struct {
	OK     bool
	Info   *KeyInfo
	Reason string
	Status int
}

// CheckOpenRouterKey asks OpenRouter about key, within five seconds. 401 or 403 is an invalid key,
// no answer is the network, anything else an error with its status.
func CheckOpenRouterKey(ctx context.Context, get Getter, key string) KeyCheck {
	key = strings.TrimSpace(key)
	if key == "" || strings.ContainsFunc(key, unicode.IsSpace) {
		return KeyCheck{Reason: "invalid"}
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	status, body, err := get(ctx, OpenRouterKeyURL, map[string]string{"authorization": "Bearer " + key, "accept": "application/json"})
	switch {
	case err != nil:
		return KeyCheck{Reason: "network"} // the transport error is not kept: it can echo headers
	case status == 401 || status == 403:
		return KeyCheck{Reason: "invalid", Status: status}
	case status < 200 || status > 299:
		return KeyCheck{Reason: "error", Status: status}
	}
	var v any
	_ = json.Unmarshal(body, &v)
	if info := ParseKeyInfo(v); info != nil {
		return KeyCheck{OK: true, Info: info}
	}
	return KeyCheck{Reason: "error", Status: status}
}

// DescribeKeyCheck is one sentence for a failed check.
func DescribeKeyCheck(c KeyCheck) string {
	switch c.Reason {
	case "invalid":
		return "OpenRouter did not accept that key. Copy it again from https://openrouter.ai/keys (it starts with sk-or-)."
	case "network":
		return "Could not reach OpenRouter to check the key. Check your connection."
	}
	status := "error"
	if c.Status != 0 {
		status = strconv.Itoa(c.Status)
	}
	return "OpenRouter could not check the key right now (HTTP " + status + "). Try again shortly."
}
