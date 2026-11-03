// Package testtime is how long a test run will take, learned from the runs before it, and what
// follows from that: whether a long run can wait for the end of the work, and whether a run is
// unchanged since it last passed, so its result can be reused instead of waited for again.
//
// It sees a run three ways, each cheaper to trust than the next is to compute: its own history
// (the same runner, scope and flags), the parts it is made of (each Go package, each test file,
// each Rust test binary, timed from the runner's own output and put back together the way the
// runner schedules them), and, with no history at all, a prior from the number of test files in
// its scope. Durations are kept as logarithms, so an estimate is a median and a 90th percentile,
// not a single number that pretends to be exact.
package testtime

import (
	"runtime"
	"slices"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// Run is a test command as Friday understands it.
type Run struct {
	// Runner is the program that runs the tests: go, cargo, pytest, vitest, jest, bun, deno, mocha,
	// rspec, phpunit, dotnet, gradle, maven, ctest, swift, or script:<name> for a package script.
	Runner string
	// Dir is where it runs, from leading `cd <dir> &&`; "" is the project root.
	Dir string
	// Scope is what it runs, sorted: packages, paths, files. Empty is the whole suite.
	Scope []string
	// Filter narrows the tests by name (-run, -k, -t, --grep, a cargo filter).
	Filter string
	// Flags are the options that change how long it takes (race, cover, count=3, short), sorted.
	Flags []string
	// Base is the command without its scope, to which a narrower scope can be appended.
	Base string
}

// Broad reports a run of the whole suite: no scope narrower than everything, and no filter.
func (r Run) Broad() bool {
	if r.Filter != "" {
		return false
	}
	for _, s := range r.Scope {
		if s != "./..." && s != "." && s != "..." {
			return false
		}
	}
	return true
}

// Key is the run's identity in the history: two commands that run the same tests the same way
// share it (`go test -v ./...` and `go test ./... -v`).
func (r Run) Key() string {
	parts := []string{r.Runner, r.Dir, strings.Join(r.Scope, ","), r.Filter, strings.Join(r.Flags, ",")}
	return strings.Join(parts, "|")
}

// runners maps a program to its runner name. The JavaScript ones are also reached through npx,
// bunx, pnpm exec and yarn.
var runners = map[string]string{
	"pytest": "pytest", "py.test": "pytest", "vitest": "vitest", "jest": "jest", "mocha": "mocha",
	"rspec": "rspec", "phpunit": "phpunit", "ctest": "ctest", "gotestsum": "go",
}

// subcommandRunners are programs whose `test` subcommand runs the tests.
var subcommandRunners = map[string]string{
	"go": "go", "cargo": "cargo", "bun": "bun", "deno": "deno", "dotnet": "dotnet", "swift": "swift",
	"gradle": "gradle", "gradlew": "gradle", "mvn": "maven", "mvnw": "maven", "mix": "mix",
}

// Detect reads a command as a test run, or reports that it is not one. Only the first test run of
// a compound command is read: `go vet ./... && go test ./...` is the `go test`.
func Detect(command string) (Run, bool) {
	tokens, err := policy.TokenizeCommand(command, runtime.GOOS)
	if err != nil || len(tokens) == 0 {
		return Run{}, false
	}
	dir := ""
	for _, seg := range segments(tokens) {
		if len(seg) >= 2 && seg[0] == "cd" {
			dir = joinDir(dir, seg[1])
			continue
		}
		if run, ok := detectSegment(seg); ok {
			run.Dir = dir
			return run, true
		}
	}
	return Run{}, false
}

// segments splits tokens on the shell's command separators.
func segments(tokens []string) [][]string {
	var out [][]string
	var cur []string
	for _, t := range tokens {
		switch t {
		case "&&", "||", ";", "|", "&":
			if len(cur) > 0 {
				out = append(out, cur)
			}
			cur = nil
			continue
		}
		if trimmed, ok := strings.CutSuffix(t, ";"); ok && trimmed != "" {
			cur = append(cur, trimmed)
			out = append(out, cur)
			cur = nil
			continue
		}
		cur = append(cur, t)
	}
	if len(cur) > 0 {
		out = append(out, cur)
	}
	return out
}

func joinDir(dir, next string) string {
	next = strings.TrimSuffix(next, "/")
	if dir == "" || strings.HasPrefix(next, "/") {
		return next
	}
	return dir + "/" + next
}

// detectSegment reads one simple command.
func detectSegment(seg []string) (Run, bool) {
	// Leading VAR=value assignments and wrappers that do not change what runs.
	i := 0
	for i < len(seg) && (isAssignment(seg[i]) || seg[i] == "env" || seg[i] == "time" || seg[i] == "nice") {
		i++
	}
	if i < len(seg) && (seg[i] == "timeout" || seg[i] == "gtimeout") {
		i += 2
	}
	if i >= len(seg) {
		return Run{}, false
	}
	head, rest := lastPathPart(seg[i]), seg[i+1:]
	prefix := seg[:i+1]
	// Launchers: npx vitest, bunx jest, pnpm exec vitest, yarn jest, python -m pytest, uv run pytest.
	switch head {
	case "npx", "bunx", "pnpx":
		if len(rest) > 0 {
			return detectSegment(append(append([]string{}, seg[:i]...), rest...))
		}
	case "python", "python3", "py":
		if len(rest) >= 2 && rest[0] == "-m" {
			if name, ok := runners[rest[1]]; ok {
				return parseArgs(name, append(append([]string{}, prefix...), rest[:2]...), rest[2:]), true
			}
			if rest[1] == "unittest" {
				return parseArgs("unittest", append(append([]string{}, prefix...), rest[:2]...), rest[2:]), true
			}
		}
		return Run{}, false
	case "uv", "poetry", "pipenv":
		if len(rest) >= 2 && rest[0] == "run" {
			return detectSegment(append(append([]string{}, seg[:i]...), rest[1:]...))
		}
	case "npm", "pnpm", "yarn":
		return detectPackageScript(head, prefix, rest)
	}
	if name, ok := runners[head]; ok {
		if head == "gotestsum" {
			// gotestsum [flags] -- <go test args>
			if at := slices.Index(rest, "--"); at >= 0 {
				return parseArgs("go", seg[:i+2+at], rest[at+1:]), true
			}
			return parseArgs("go", prefix, nil), true
		}
		return parseArgs(name, prefix, rest), true
	}
	if name, ok := subcommandRunners[head]; ok && len(rest) > 0 && rest[0] == "test" {
		if name == "bun" && len(rest) > 1 && rest[1] == "--watch" {
			return Run{}, false
		}
		return parseArgs(name, append(append([]string{}, prefix...), "test"), rest[1:]), true
	}
	if (head == "make" || head == "just" || head == "task") && len(rest) > 0 && strings.HasPrefix(rest[0], "test") {
		return Run{Runner: "script:" + head + ":" + rest[0], Base: strings.Join(seg, " ")}, true
	}
	return Run{}, false
}

// detectPackageScript reads `npm test`, `npm run test:unit`, `pnpm vitest`, `yarn jest src/a`.
func detectPackageScript(pm string, prefix, rest []string) (Run, bool) {
	if len(rest) == 0 {
		return Run{}, false
	}
	switch rest[0] {
	case "test", "t":
		return parseArgs("script:"+pm+":test", append(append([]string{}, prefix...), rest[0]), trimDashDash(rest[1:])), true
	case "run", "run-script":
		if len(rest) > 1 && strings.Contains(rest[1], "test") {
			return parseArgs("script:"+pm+":"+rest[1], append(append([]string{}, prefix...), rest[:2]...), trimDashDash(rest[2:])), true
		}
		return Run{}, false
	case "exec", "dlx":
		if len(rest) > 1 {
			if name, ok := runners[rest[1]]; ok {
				return parseArgs(name, append(append([]string{}, prefix...), rest[:2]...), rest[2:]), true
			}
		}
		return Run{}, false
	}
	if name, ok := runners[rest[0]]; ok && pm != "npm" {
		return parseArgs(name, append(append([]string{}, prefix...), rest[0]), rest[1:]), true
	}
	return Run{}, false
}

func trimDashDash(args []string) []string {
	if len(args) > 0 && args[0] == "--" {
		return args[1:]
	}
	return args
}

// costFlags are the flags that change how long a run takes, by runner family, with whether they
// take a value. Every other flag is kept in Base but is not part of the identity.
var costFlags = map[string]bool{
	"-race": false, "-cover": false, "-short": false, "-count": true, "-p": true, "-parallel": true,
	"-bench": true, "-coverprofile": true, "-covermode": true, "-cpu": true, "-tags": true,
	"--coverage": false, "--runInBand": false, "-i": false, "--release": false, "--all-features": false,
	"--workspace": false, "-x": false, "--exitfirst": false, "-n": true, "--maxWorkers": true,
	"--slow": false, "--full": false,
}

// filterFlags narrow tests by name.
var filterFlags = map[string]bool{"-run": true, "-k": true, "-t": true, "--grep": true, "--testNamePattern": true, "--test-name-pattern": true, "--filter": true, "-g": true, "-m": true}

// scopeless runners take arguments that are not paths: they are filters (cargo test name).
var nameArgRunners = map[string]bool{"cargo": true}

// parseArgs builds a Run from a runner's arguments.
func parseArgs(runner string, prefix, args []string) Run {
	run := Run{Runner: runner}
	base := append([]string{}, prefix...)
	afterDashes := false
	for k := 0; k < len(args); k++ {
		a := args[k]
		if a == "--" {
			afterDashes = true
			base = append(base, a)
			continue
		}
		if strings.HasPrefix(a, "-") && !afterDashes {
			name, value, hasValue := strings.Cut(a, "=")
			takes, cost := costFlags[name]
			_, filter := filterFlags[name]
			switch {
			case filter:
				if !hasValue && k+1 < len(args) {
					k++
					value = args[k]
				}
				run.Filter = strings.TrimSpace(run.Filter + " " + value)
				continue
			case cost:
				if takes && !hasValue && k+1 < len(args) {
					k++
					value = args[k]
					a = name + "=" + value
				}
				if name == "-count" && value == "1" {
					// -count=1 only turns off Go's cache: same tests, same cost per test.
					base = append(base, a)
					continue
				}
				run.Flags = append(run.Flags, strings.TrimLeft(a, "-"))
			}
			base = append(base, a)
			continue
		}
		if afterDashes && nameArgRunners[runner] {
			// cargo test -- <filter> --nocapture
			run.Filter = strings.TrimSpace(run.Filter + " " + a)
			continue
		}
		if nameArgRunners[runner] {
			run.Filter = strings.TrimSpace(run.Filter + " " + a)
			continue
		}
		if runner == "vitest" && len(run.Scope) == 0 && (a == "run" || a == "related" || a == "watch" || a == "dev") {
			base = append(base, a) // vitest's subcommands
			continue
		}
		if runner == "dotnet" || runner == "gradle" || runner == "maven" || runner == "mix" || runner == "swift" {
			base = append(base, a)
			continue
		}
		// Go's packages keep their ./ so `./...` reads as itself; everything else is a plain path.
		if runner == "go" {
			if a == "..." {
				a = "./..."
			}
			run.Scope = append(run.Scope, a)
			continue
		}
		run.Scope = append(run.Scope, strings.TrimPrefix(a, "./"))
	}
	slices.Sort(run.Scope)
	run.Scope = slices.Compact(run.Scope)
	slices.Sort(run.Flags)
	run.Base = strings.Join(base, " ")
	return run
}

func isAssignment(token string) bool {
	eq := strings.IndexByte(token, '=')
	if eq <= 0 {
		return false
	}
	for _, c := range token[:eq] {
		if !(c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

func lastPathPart(token string) string {
	if slash := strings.LastIndexAny(token, `/\`); slash >= 0 {
		return token[slash+1:]
	}
	return token
}
