package server

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// permissionOptions are the ledger's decisions as ACP options (ACP_PERMISSION_OPTIONS in acp.ts);
// a broader pattern, when the ledger offers one, comes third.
func permissionOptions(pattern *policy.Pattern) []map[string]any {
	options := []map[string]any{
		{"optionId": "allow", "name": "Allow", "kind": "allow_once"},
		{"optionId": "allow_always", "name": "Allow this action from now on", "kind": "allow_always"},
		{"optionId": "deny", "name": "Deny", "kind": "reject_once"},
		{"optionId": "deny_always", "name": "Deny this action from now on", "kind": "reject_always"},
	}
	if pattern != nil {
		label := pattern.Label
		if r := []rune(label); len(r) > 0 {
			label = strings.ToUpper(string(r[:1])) + string(r[1:])
		}
		extra := map[string]any{"optionId": "allow_pattern", "name": label, "kind": "allow_always"}
		options = append(options[:2], append([]map[string]any{extra}, options[2:]...)...)
	}
	return options
}

// askPermission puts one approval to the client. Anything but a selected allow is a denial: a
// client that went away has not consented.
func (s *Server) askPermission(ctx context.Context, sessionID string, r policy.Request) (policy.Decision, error) {
	title := r.Summary
	if r.Safety.Sensitive && len(r.Safety.Reasons) > 0 {
		title += " — " + strings.Join(r.Safety.Reasons, "; ")
	}
	raw, err := s.request(ctx, "session/request_permission", map[string]any{
		"sessionId": sessionID,
		"toolCall":  map[string]any{"toolCallId": r.Call.ID, "title": title, "kind": toolKind(r.Call.Name), "status": "pending"},
		"options":   permissionOptions(r.Pattern),
	})
	if err != nil {
		if ctx.Err() != nil {
			return policy.Deny, ctx.Err()
		}
		return policy.Deny, nil
	}
	return decisionFrom(raw, r.Pattern != nil), nil
}

// decisionFrom reads both shapes of an answer: ACP's nested `{outcome: {outcome, optionId}}`, as
// Zed sends it, and the Go interface's flat `{outcome, selectedOptionId}`.
func decisionFrom(raw json.RawMessage, patternOffered bool) policy.Decision {
	var flat struct {
		Outcome          json.RawMessage `json:"outcome"`
		OptionID         string          `json:"optionId"`
		SelectedOptionID string          `json:"selectedOptionId"`
	}
	if json.Unmarshal(raw, &flat) != nil {
		return policy.Deny
	}
	outcome, option := "", firstNonEmpty(flat.OptionID, flat.SelectedOptionID)
	var nested struct {
		Outcome          string `json:"outcome"`
		OptionID         string `json:"optionId"`
		SelectedOptionID string `json:"selectedOptionId"`
	}
	if json.Unmarshal(flat.Outcome, &nested) == nil && nested.Outcome != "" {
		outcome, option = nested.Outcome, firstNonEmpty(nested.OptionID, nested.SelectedOptionID)
	} else {
		_ = json.Unmarshal(flat.Outcome, &outcome)
	}
	if outcome != "selected" {
		return policy.Deny
	}
	switch option {
	case "allow", "allow_always", "deny_always":
		return policy.Decision(option)
	case "allow_pattern":
		if patternOffered {
			return policy.AllowPattern
		}
	}
	return policy.Deny
}

// askQuestion puts ask_user's question to the client; "" is a dismissal.
func (s *Server) askQuestion(ctx context.Context, sessionID, question string, options []string, multi bool) (string, error) {
	if options == nil {
		options = []string{}
	}
	raw, err := s.request(ctx, "_archymedes/session/ask", map[string]any{"sessionId": sessionID, "question": question, "options": options, "multiSelect": multi})
	if err != nil {
		return "", err
	}
	var reply struct {
		Answer string `json:"answer"`
	}
	_ = json.Unmarshal(raw, &reply)
	return strings.TrimSpace(reply.Answer), nil
}
