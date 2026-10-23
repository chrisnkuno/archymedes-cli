package tool

import (
	"fmt"
	"slices"
)

// Capabilities are every capability id a tool may belong to.
var Capabilities = []string{CapRead, CapWrite, CapTerminal, CapResearch, CapPlanning, CapExternal, CapPlaybooks}

// Contract checks what the loop relies on in a tool, beyond its words: a known capability and
// effect, a body, and a schema whose required arguments exist and whose arguments say their type.
// The words (name, description) are checked by internal/conform; this is the shape.
func Contract(t *Tool) []string {
	var problems []string
	if !slices.Contains(Capabilities, t.Capability) {
		problems = append(problems, fmt.Sprintf("%s: capability %q is not one of %v", t.Name, t.Capability, Capabilities))
	}
	switch t.Effect {
	case EffectNone, EffectWorkspace, EffectExternal:
	default:
		problems = append(problems, fmt.Sprintf("%s: effect %q is not none, workspace or external", t.Name, t.Effect))
	}
	if t.Run == nil {
		problems = append(problems, t.Name+": no Run")
	}
	if t.Schema == nil {
		return append(problems, t.Name+": no schema")
	}
	if t.Schema["type"] != "object" {
		problems = append(problems, t.Name+": schema is not an object")
	}
	properties, _ := t.Schema["properties"].(map[string]any)
	for name, raw := range properties {
		prop, _ := raw.(map[string]any)
		if _, ok := prop["type"]; !ok {
			problems = append(problems, fmt.Sprintf("%s: argument %q has no type", t.Name, name))
		}
	}
	required, _ := t.Schema["required"].([]string)
	for _, name := range required {
		if _, ok := properties[name]; !ok {
			problems = append(problems, fmt.Sprintf("%s: required argument %q is not among its properties", t.Name, name))
		}
	}
	return problems
}
