package roles

import (
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/conform"
)

// TestConformBuiltInRoles holds every built-in role to the standard: its name and the description
// the model reads beside it.
func TestConformBuiltInRoles(t *testing.T) {
	var names []string
	for _, p := range BuiltIn() {
		names = append(names, p.Name)
		for _, problem := range append(conform.Name("role", p.Name), conform.RoleDescription(p.Description)...) {
			t.Errorf("%s: %s", p.Name, problem)
		}
		if p.Instructions == "" || p.MaxIterations <= 0 || p.MaxToolCalls <= 0 || (p.Model != ModelMain && p.Model != ModelSmall) {
			t.Errorf("%s is incomplete: %+v", p.Name, p)
		}
	}
	for _, problem := range conform.Unique("role", names) {
		t.Error(problem)
	}
}
