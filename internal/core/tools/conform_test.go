package tools

import (
	"os"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/conform"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// TestConformBuiltinTools holds every built-in tool to the standard (docs/mechanisms/README.md):
// its name, its description, its shape, and its entry in the tools reference.
func TestConformBuiltinTools(t *testing.T) {
	docs, err := os.ReadFile("../../../docs/engine/TOOLS.md")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range NewWorkspace(t.TempDir()).Builtins() {
		names = append(names, tl.Name)
		for _, p := range append(append(conform.Name("tool", tl.Name), conform.ToolDescription(tl.Description)...), tool.Contract(tl)...) {
			t.Errorf("%s: %s", tl.Name, p)
		}
		if !strings.Contains(string(docs), "`"+tl.Name+"`") {
			t.Errorf("%s is not in docs/engine/TOOLS.md", tl.Name)
		}
	}
	for _, p := range conform.Unique("tool", names) {
		t.Error(p)
	}
}
