package tool

import (
	"regexp"
	"strings"
)

// Tool names models write that are not quite ours (packages/core/src/tool-aliases.ts, the part
// whose arguments need no translating). gpt-oss, trained on its own harness, calls
// `repo_browser.run_command`; several open models put `functions.` in front of every name; others
// write `ReadFile` or `read-file`. Each has exactly one meaning here.

// qualified are namespaced names whose namespace changes the meaning; matched before stripping.
var qualified = map[string]string{
	"repo_browser.open_file":  "read_file",
	"repo_browser.print_tree": "list_files",
	"repo_browser.search":     "grep_files",
}

// namespaces are prefixes that carry no meaning of their own.
var namespaces = regexp.MustCompile(`(?i)^(functions|function|default_api|tools|tool|api|repo_browser)[.:/]`)

var camel = regexp.MustCompile(`([a-z0-9])([A-Z])`)

// Resolve is the catalog's name for a tool a model named not quite right, if it has one.
func Resolve(c *Catalog, name string) (string, bool) {
	if _, ok := c.Lookup(name); ok {
		return name, true
	}
	if ours, ok := qualified[strings.ToLower(strings.TrimSpace(name))]; ok {
		if _, found := c.Lookup(ours); found {
			return ours, true
		}
	}
	bare := namespaces.ReplaceAllString(strings.TrimSpace(name), "")
	bare = strings.ToLower(strings.NewReplacer(" ", "_", "-", "_").Replace(camel.ReplaceAllString(bare, "${1}_${2}")))
	if _, ok := c.Lookup(bare); ok && bare != "" {
		return bare, true
	}
	return "", false
}
