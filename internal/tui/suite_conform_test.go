package tui

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/conform"
)

// The interface's mechanisms, held to the standard (docs/mechanisms/README.md): every slash
// command, every key action, and every message the interface shows.

func report(t *testing.T, where string, problems []string) {
	t.Helper()
	for _, p := range problems {
		t.Errorf("%s: %s", where, p)
	}
}

func TestConformSlashCommands(t *testing.T) {
	var names []string
	for _, c := range commands {
		names = append(names, c.name)
		report(t, "/"+c.name, conform.Name("command", c.name))
		report(t, "/"+c.name, conform.Help(c.help))
		report(t, "/"+c.name, conform.ArgHint(c.args))
		if c.run == nil {
			t.Errorf("/%s does nothing", c.name)
		}
	}
	report(t, "commands", conform.Unique("command", names))
}

func TestConformKeyActions(t *testing.T) {
	groups := map[string]bool{"Typing": true, "Apps": true, "Windows": true, "Session": true, "Reading": true}
	var ids []string
	for _, a := range actions {
		ids = append(ids, a.id)
		report(t, a.id, conform.Name("action", a.id))
		report(t, a.id, conform.Label(a.label))
		if !groups[a.group] {
			t.Errorf("%s: group %q is not one of the five", a.id, a.group)
		}
		if len(a.defaults) == 0 || a.field == nil {
			t.Errorf("%s has no key or no binding", a.id)
		}
	}
	report(t, "actions", conform.Unique("action", ids))
}

// TestConformMessages reads every toast and notice written as a literal in the interface's source
// and holds it to the message rules. A message built at run time is held to them where its literal
// part starts it.
func TestConformMessages(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	fset := token.NewFileSet()
	checked := 0
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		f, err := parser.ParseFile(fset, file, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) != 2 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (sel.Sel.Name != "toast" && sel.Sel.Name != "notice") {
				return true
			}
			text, kind := literalStart(call.Args[1])
			if text == "" {
				return true
			}
			checked++
			at := fset.Position(call.Pos()).String()
			problems := conform.Message(text)
			switch kind {
			case formatted:
				// The values are filled in at run time: everything but the length can be judged.
				problems = without(problems, "characters; at most")
			case prefix:
				// The rest is added at run time: only how it starts can be judged here.
				problems = startProblems(problems)
			}
			report(t, at, problems)
			return true
		})
	}
	if checked < 50 {
		t.Fatalf("only %d messages found; the scan is not seeing the source", checked)
	}
}

// How much of a message is known from its source.
const (
	whole     = iota // a literal: all of it
	formatted        // fmt.Sprintf's format: all but the values
	prefix           // "literal " + value: how it starts
)

// literalStart is the literal text an expression is made from, and how much of it that is.
func literalStart(e ast.Expr) (string, int) {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind == token.STRING {
			if s, err := strconv.Unquote(v.Value); err == nil {
				return s, whole
			}
		}
	case *ast.BinaryExpr:
		if v.Op == token.ADD {
			s, _ := literalStart(v.X)
			return s, prefix
		}
	case *ast.CallExpr:
		if sel, ok := v.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Sprintf" && len(v.Args) > 0 {
			if lit, ok := v.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
				if s, err := strconv.Unquote(lit.Value); err == nil {
					return s, formatted
				}
			}
		}
	}
	return "", whole
}

func without(problems []string, about string) []string {
	var out []string
	for _, p := range problems {
		if !strings.Contains(p, about) {
			out = append(out, p)
		}
	}
	return out
}

// startProblems keeps only the problems about how a message starts.
func startProblems(problems []string) []string {
	var out []string
	for _, p := range problems {
		if strings.Contains(p, "lower case") || strings.Contains(p, "opens with") || strings.Contains(p, "stand alone") || strings.Contains(p, "shouts") || strings.Contains(p, "doubled space") {
			out = append(out, p)
		}
	}
	return out
}
