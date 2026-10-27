package conform

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

// The repository-wide checks: what crosses packages, languages and documents. They read the source
// as text, from the repository root.

const root = "../.."

// goSource is every non-test Go file under internal/ and cmd/, by path.
func goSource(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			data, err := os.ReadFile(path)
			out[path] = string(data)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func docs(t *testing.T, files ...string) string {
	t.Helper()
	var b strings.Builder
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			t.Fatal(err)
		}
		b.Write(data)
	}
	return b.String()
}

var envVar = regexp.MustCompile(`"(ARCHYMEDES_[A-Z0-9_]+)"`)

// TestConformEveryVariableIsDocumented: a variable the Go code reads that no document names is a
// setting nobody can find.
func TestConformEveryVariableIsDocumented(t *testing.T) {
	documented := docs(t, "README.md", "docs/engine/CONFIGURATION.md", "docs/engine/USER_GUIDE.md", "docs/mechanisms/README.md")
	seen := map[string][]string{}
	for path, src := range goSource(t) {
		for _, m := range envVar.FindAllStringSubmatch(src, -1) {
			seen[m[1]] = append(seen[m[1]], strings.TrimPrefix(path, root+"/"))
		}
	}
	if len(seen) < 10 {
		t.Fatalf("only %d variables found; the scan is not seeing the source", len(seen))
	}
	var names []string
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		for _, p := range Name("setting", name) {
			t.Error(p)
		}
		if !strings.Contains(documented, name) {
			t.Errorf("%s (read in %s) is in no document", name, strings.Join(seen[name], ", "))
		}
	}
}

var settingRead = regexp.MustCompile(`config\.Setting\([^,]+, "([A-Z0-9_]+)"\)`)
var settingField = regexp.MustCompile(`\{Key: "([A-Z0-9_]+)"`)

// TestConformSettingsTheBinaryReadsExist: a key the Go binary reads from settings.json must be a
// row of the Settings list (internal/core/settings/fields.go), or nobody can set it.
func TestConformSettingsTheBinaryReadsExist(t *testing.T) {
	fields := map[string]bool{}
	for _, m := range settingField.FindAllStringSubmatch(docs(t, "internal/core/settings/fields.go"), -1) {
		fields[m[1]] = true
	}
	if len(fields) < 20 {
		t.Fatalf("only %d settings found; the scan is not seeing fields.go", len(fields))
	}
	for path, src := range goSource(t) {
		for _, m := range settingRead.FindAllStringSubmatch(src, -1) {
			if !fields[m[1]] {
				t.Errorf("%s reads setting %s, which is not a row of the Settings list", strings.TrimPrefix(path, root+"/"), m[1])
			}
		}
	}
}

var (
	tsSettingRow = regexp.MustCompile(`\{ key: "([A-Z0-9_]+)", label: "([^"]*)"`)
	goSettingRow = regexp.MustCompile(`\{Key: "([A-Z0-9_]+)", Label: "([^"]*)"`)
)

// TestConformTheTwoSettingsListsAgree: until the TypeScript engine is deleted (WS-50.10) both
// engines save settings.json and each drops the keys its own list lacks, so the two lists must name
// the same settings, in the same order, in the same words. Delete this test with settings.ts.
func TestConformTheTwoSettingsListsAgree(t *testing.T) {
	ts := tsSettingRow.FindAllStringSubmatch(docs(t, "packages/friday-cli/src/platform/settings.ts"), -1)
	gs := goSettingRow.FindAllStringSubmatch(docs(t, "internal/core/settings/fields.go"), -1)
	if len(ts) < 60 || len(gs) < 60 {
		t.Fatalf("found %d TypeScript and %d Go rows; the scan is not seeing the lists", len(ts), len(gs))
	}
	for i := 0; i < max(len(ts), len(gs)); i++ {
		var tsRow, goRow string
		if i < len(ts) {
			tsRow = ts[i][1] + ": " + ts[i][2]
		}
		if i < len(gs) {
			goRow = gs[i][1] + ": " + gs[i][2]
		}
		if tsRow != goRow {
			t.Errorf("row %d differs:\n settings.ts %s\n fields.go   %s", i, tsRow, goRow)
		}
	}
}

// goFiles parses every non-test Go file under internal/ and cmd/.
func goFiles(t *testing.T) map[string]*ast.File {
	t.Helper()
	fset := token.NewFileSet()
	out := map[string]*ast.File{}
	for path, src := range goSource(t) {
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		out[strings.TrimPrefix(path, root+"/")] = f
	}
	return out
}

// literal is the text a call argument opens with: a string literal, the format of a
// fmt.Sprintf, or the left end of a concatenation.
func literal(e ast.Expr) (string, bool) {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind == token.STRING {
			s, err := strconv.Unquote(v.Value)
			return s, err == nil
		}
	case *ast.BinaryExpr:
		if v.Op == token.ADD {
			return literal(v.X)
		}
	case *ast.CallExpr:
		if callee(v) == "fmt.Sprintf" && len(v.Args) > 0 {
			return literal(v.Args[0])
		}
	}
	return "", false
}

func callee(call *ast.CallExpr) string {
	if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
		if pkg, ok := sel.X.(*ast.Ident); ok {
			return pkg.Name + "." + sel.Sel.Name
		}
	}
	return ""
}

// TestConformErrorsToolTextAndStderr: Go error values follow Go's convention (lower case, no
// closing punctuation); text a tool hands the model is a sentence; every line the binary writes to
// stderr is prefixed "friday:", so it is known whose it is.
func TestConformErrorsToolTextAndStderr(t *testing.T) {
	counts := map[string]int{}
	for path, f := range goFiles(t) {
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			var problems []string
			switch name := callee(call); name {
			case "errors.New", "fmt.Errorf":
				if text, ok := literal(call.Args[0]); ok {
					counts["error"]++
					problems = GoError(text)
				}
			case "tool.Error":
				if text, ok := literal(call.Args[0]); ok {
					counts["tool"]++
					problems = ToolText(text)
				}
			case "fmt.Fprintln", "fmt.Fprintf", "fmt.Fprint":
				if sel, ok := call.Args[0].(*ast.SelectorExpr); ok && sel.Sel.Name == "Stderr" && strings.HasPrefix(path, "cmd/") && len(call.Args) > 1 {
					counts["stderr"]++
					if text, ok := literal(call.Args[1]); !ok || !strings.HasPrefix(text, "friday:") {
						problems = []string{"a stderr line does not open with \"friday:\""}
					}
				}
			}
			for _, p := range problems {
				t.Errorf("%s: %s", path, p)
			}
			return true
		})
	}
	if counts["error"] < 50 || counts["tool"] < 20 || counts["stderr"] < 5 {
		t.Fatalf("the scan found too little (%v); it is not seeing the source", counts)
	}
}

// documents are the pages the standard holds to its documentation rules. The continuation notes
// (docs/continuation) are working records; their links and paths are checked, not their prose.
var documents = []string{
	"README.md",
	"packages/friday-cli/README.md",
	"docs/mechanisms/README.md",
	"docs/RELEASING.md",
	"docs/engine/README.md",
	"docs/engine/USER_GUIDE.md",
	"docs/engine/CONFIGURATION.md",
	"docs/engine/TOOLS.md",
	"docs/engine/SUBAGENTS.md",
	"docs/engine/EDITORS.md",
	"docs/engine/ARCHITECTURE.md",
	"docs/engine/PROTOCOL.md",
	"docs/engine/EXTENDING.md",
	"internal/gallery/CREDITS.md",
}

var records = []string{"docs/continuation/GO_ENGINE.md", "docs/continuation/CODEBASE.md"}

// TestConformDocuments: each document has one title and a sentence of purpose, descending
// headings, whole tables, sentences of at most MaxSentenceWords words, no filler and no word the
// vocabulary retired.
func TestConformDocuments(t *testing.T) {
	for _, doc := range documents {
		text := docs(t, doc)
		for _, p := range append(DocStructure(text), DocProse(text)...) {
			t.Errorf("%s: %s", doc, p)
		}
	}
}

var (
	mdLink     = regexp.MustCompile(`\]\(([^)\s]+)\)`)
	codePath   = regexp.MustCompile("`((?:internal|cmd|docs|packages|tooling)/[A-Za-z0-9_./-]+)`")
	testName   = regexp.MustCompile("`(TestConform[A-Za-z0-9_]*)")
	variable   = regexp.MustCompile("`(ARCHYMEDES_[A-Z0-9_]+)")
	headingRef = regexp.MustCompile(`(?m)^#{1,6} (.+)$`)
)

// anchor is GitHub's anchor for a heading.
func anchor(heading string) string {
	heading = strings.ToLower(strings.TrimSpace(heading))
	var b strings.Builder
	for _, r := range heading {
		switch {
		case r == ' ':
			b.WriteRune('-')
		case r == '-' || r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		}
	}
	return b.String()
}

func anchors(text string) map[string]bool {
	out := map[string]bool{}
	for _, m := range headingRef.FindAllStringSubmatch(ParseDoc(text).Raw, -1) {
		a := anchor(strings.ReplaceAll(m[1], "`", ""))
		for n := 0; out[a]; n++ {
			a = fmt.Sprintf("%s-%d", anchor(m[1]), n+1)
		}
		out[a] = true
	}
	return out
}

// TestConformDocumentReferences: every link resolves to a file and, if it names one, a heading;
// every path, conformance test and variable a document writes in code exists.
func TestConformDocumentReferences(t *testing.T) {
	var tests, vars strings.Builder
	for _, dir := range []string{"internal", "cmd"} {
		filepath.WalkDir(filepath.Join(root, dir), func(path string, d os.DirEntry, err error) error {
			if err == nil && strings.HasSuffix(path, ".go") {
				data, _ := os.ReadFile(path)
				tests.Write(data)
			}
			return nil
		})
	}
	vars.WriteString(tests.String())
	// The TypeScript agent reads variables too.
	filepath.WalkDir(filepath.Join(root, "packages"), func(path string, d os.DirEntry, err error) error {
		if err == nil && d.IsDir() && (d.Name() == "node_modules" || d.Name() == "dist") {
			return filepath.SkipDir
		}
		if err == nil && strings.HasSuffix(path, ".ts") && !strings.HasSuffix(path, ".test.ts") {
			data, _ := os.ReadFile(path)
			vars.Write(data)
		}
		return nil
	})
	for _, doc := range append(append([]string{}, documents...), records...) {
		text := ParseDoc(docs(t, doc)).Raw
		dir := filepath.Dir(doc)
		for _, m := range mdLink.FindAllStringSubmatch(text, -1) {
			target := m[1]
			if strings.Contains(target, "://") || strings.HasPrefix(target, "mailto:") {
				continue
			}
			file, frag, _ := strings.Cut(target, "#")
			path := doc
			if file != "" {
				path = filepath.Join(dir, file)
				if _, err := os.Stat(filepath.Join(root, path)); err != nil {
					t.Errorf("%s: link %q leads nowhere", doc, target)
					continue
				}
			}
			if frag != "" && strings.HasSuffix(path, ".md") && !anchors(docs(t, path))[frag] {
				t.Errorf("%s: link %q names no heading in %s", doc, target, path)
			}
		}
		for _, m := range codePath.FindAllStringSubmatch(text, -1) {
			p := strings.TrimRight(strings.SplitN(m[1], ":", 2)[0], ".")
			if strings.ContainsAny(p, "*<{") {
				continue
			}
			if _, err := os.Stat(filepath.Join(root, p)); err != nil {
				t.Errorf("%s: path `%s` does not exist", doc, p)
			}
		}
		for _, m := range testName.FindAllStringSubmatch(text, -1) {
			if m[1] != "TestConform" && !strings.Contains(tests.String(), "func "+m[1]) {
				t.Errorf("%s: test %s does not exist", doc, m[1])
			}
		}
		for _, m := range variable.FindAllStringSubmatch(text, -1) {
			if !regexp.MustCompile(`\b` + m[1] + `\b[^_]`).MatchString(vars.String()) {
				t.Errorf("%s: variable %s is read nowhere", doc, m[1])
			}
		}
	}
}
