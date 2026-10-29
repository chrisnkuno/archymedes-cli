package agents

import (
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/roles"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
	"github.com/chrisnkuno/friday-cli/internal/core/tools"
)

// TestReadOnlyRolesGetNoBackgroundCommands: starting, reading and stopping background commands are
// terminal tools, which a read-only sub-agent in plan mode never gets.
func TestReadOnlyRolesGetNoBackgroundCommands(t *testing.T) {
	w := tools.NewWorkspace(t.TempDir())
	t.Cleanup(w.Close)
	for _, tl := range roles.ToolsFor(roles.Profile{ReadOnly: true}, w.Builtins(), policy.CapabilitiesForMode(policy.Plan)) {
		if tl.Capability == tool.CapTerminal {
			t.Errorf("a read-only role gets %s", tl.Name)
		}
	}
}
