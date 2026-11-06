package llm

import "testing"

// On Windows environment names are case-insensitive: the system keeps PATH as `Path`, and a lookup
// of PATH must find it, as Node's process.env does. Elsewhere names keep their case.
func TestEnvNamesIgnoreCaseOnWindowsOnly(t *testing.T) {
	e := Env{"Path": `C:\npm`, "OPENROUTER_API_KEY": "k"}
	defer func(old bool) { envFoldCase = old }(envFoldCase)

	envFoldCase = true
	if got := e.Get("PATH"); got != `C:\npm` {
		t.Fatalf("windows: PATH = %q, want the Path entry", got)
	}
	if got := e.Get("openrouter_api_key"); got != "k" {
		t.Fatalf("windows: lower-case name = %q", got)
	}
	if got := e.Get("MISSING"); got != "" {
		t.Fatalf("windows: missing = %q", got)
	}

	envFoldCase = false
	if got := e.Get("PATH"); got != "" {
		t.Fatalf("elsewhere: PATH must not match Path, got %q", got)
	}
}
