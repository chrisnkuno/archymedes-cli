package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"regexp"
	"slices"
	"strconv"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/cli"
	"github.com/chrisnkuno/friday-cli/internal/conform"
)

var flagInHelp = regexp.MustCompile(`(?m)(?:^|[\s,|(\[])(--?[a-zA-Z][a-zA-Z0-9-]*)`)

// TestConformHelpNamesRealFlags holds `friday --help` to the parser: every flag it names is one the
// parser knows, in the flag grammar, and every flag only the binary reads is named in it.
func TestConformHelpNamesRealFlags(t *testing.T) {
	known := cli.KnownFlags()
	var named []string
	for _, m := range flagInHelp.FindAllStringSubmatch(usage, -1) {
		named = append(named, m[1])
	}
	if len(named) < 15 {
		t.Fatalf("only %d flags found in the help: %v", len(named), named)
	}
	for _, flag := range named {
		for _, p := range conform.Name("flag", flag) {
			t.Error(p)
		}
		if !slices.Contains(known, flag) {
			t.Errorf("the help names %s, which the parser does not know", flag)
		}
	}
	for _, flag := range cli.GoOnlyFlags() {
		if !slices.Contains(named, flag) {
			t.Errorf("%s is read by the binary but not named in the help", flag)
		}
	}
}

// TestConformExitCodes holds the binary to three exit codes: 0 done, 1 failed while running,
// 2 refused before starting (a usage or setup problem). A passthrough returns the agent's own.
func TestConformExitCodes(t *testing.T) {
	fset := token.NewFileSet()
	for _, file := range []string{"main.go", "engine.go"} {
		f, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			fn, ok := n.(*ast.FuncDecl)
			if !ok || fn.Type.Results == nil || len(fn.Type.Results.List) != 1 {
				return true
			}
			if id, ok := fn.Type.Results.List[0].Type.(*ast.Ident); !ok || id.Name != "int" {
				return true
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				ret, ok := n.(*ast.ReturnStmt)
				if !ok || len(ret.Results) != 1 {
					return true
				}
				if lit, ok := ret.Results[0].(*ast.BasicLit); ok {
					if code, _ := strconv.Atoi(lit.Value); code < 0 || code > 2 {
						t.Errorf("%s: %s returns %d; the codes are 0, 1 and 2", fset.Position(ret.Pos()), fn.Name.Name, code)
					}
				}
				return true
			})
			return true
		})
	}
}
