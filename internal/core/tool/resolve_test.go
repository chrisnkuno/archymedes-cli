package tool

import "testing"

func TestResolveFindsOurToolUnderAnotherSpellingOrNamespace(t *testing.T) {
	c := NewCatalog(&Tool{Name: "run_command"}, &Tool{Name: "read_file"}, &Tool{Name: "list_files"})
	for name, want := range map[string]string{
		"run_command": "run_command", "repo_browser.run_command": "run_command", "functions.read_file": "read_file",
		"ReadFile": "read_file", "read-file": "read_file", "repo_browser.print_tree": "list_files", "default_api:run_command": "run_command",
	} {
		if got, ok := Resolve(c, name); !ok || got != want {
			t.Errorf("Resolve(%q) = %q, %v; want %q", name, got, ok, want)
		}
	}
	for _, name := range []string{"rm_rf", "browser.search", "repo_browser.search"} {
		if got, ok := Resolve(c, name); ok {
			t.Errorf("Resolve(%q) = %q; want no match", name, got)
		}
	}
}
