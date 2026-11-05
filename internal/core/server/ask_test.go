package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// TestARiskyApprovalSaysItsRiskApartFromItsTitle: the interface (and a phone notification) can tell
// a risky approval from an ordinary one without reading the title's words.
func TestARiskyApprovalSaysItsRiskApartFromItsTitle(t *testing.T) {
	risky := policy.Request{Call: tool.Call{ID: "c1", Name: "run_command"}, Summary: "run git push origin main",
		Safety: policy.Safety{Sensitive: true, Reasons: []string{"deployment or package publication command"}}}
	raw, _ := json.Marshal(permissionParams("s1", risky))
	var got struct {
		ToolCall struct{ Title string } `json:"toolCall"`
		Meta     struct {
			Archymedes struct{ Risk []string } `json:"archymedes"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Meta.Archymedes.Risk) != 1 || got.Meta.Archymedes.Risk[0] != "deployment or package publication command" {
		t.Fatalf("risk not sent: %s", raw)
	}
	if !strings.Contains(got.ToolCall.Title, "— deployment") {
		t.Fatalf("the title lost its reasons: %q", got.ToolCall.Title)
	}

	plain, _ := json.Marshal(permissionParams("s1", policy.Request{Call: tool.Call{ID: "c2", Name: "write_file"}, Summary: "write a.txt"}))
	if strings.Contains(string(plain), "_meta") {
		t.Fatalf("an ordinary approval carried a risk: %s", plain)
	}
}
