package policy

import (
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

func TestClassifyVerification(t *testing.T) {
	for command, want := range map[string]tool.EvidenceKind{
		// Executed behaviour versus evidence that the code merely compiles.
		"npm test":                        tool.EvidenceTests,
		"pytest -q":                       tool.EvidenceTests,
		"go test ./...":                   tool.EvidenceTests,
		"cargo test":                      tool.EvidenceTests,
		"bunx vitest run":                 tool.EvidenceTests,
		"npx jest --ci":                   tool.EvidenceTests,
		"bundle exec rspec":               tool.EvidenceTests,
		"bunx tsc --noEmit":               tool.EvidenceCheck,
		"eslint .":                        tool.EvidenceCheck,
		"python3 -m py_compile tetris.py": tool.EvidenceCheck,
		"npm run build":                   tool.EvidenceCheck,
		"ruff check .":                    tool.EvidenceCheck,
		"mypy .":                          tool.EvidenceCheck,
		"cargo clippy":                    tool.EvidenceCheck,
		"go vet ./...":                    tool.EvidenceCheck,
		"cargo fmt --check":               tool.EvidenceCheck,
		"git status":                      "",
		"echo hello":                      "",
		// A keyword in the directory a command ran in is not evidence.
		"cd /tmp/arch-e2e && ls -la":             "",
		"cd /tmp/arch-e2e && bun test":           tool.EvidenceTests,
		"cd ../proj && cd src && pytest -q":      tool.EvidenceTests,
		"cd /tmp/check && npm run build":         tool.EvidenceCheck,
		"cd /tmp/check && timeout 5 npm run dev": "",
		"cd a && cd b && go test ./...":          tool.EvidenceTests,
		// The assembled program exercised.
		"npx playwright test":                    tool.EvidenceBehavior,
		"npm run e2e":                            tool.EvidenceBehavior,
		"yarn cypress run":                       tool.EvidenceBehavior,
		"pytest tests/integration":               tool.EvidenceBehavior,
		"npm run test:integration":               tool.EvidenceBehavior,
		"behave features/":                       tool.EvidenceBehavior,
		"npm run smoke":                          tool.EvidenceSmoke,
		"curl -sf http://localhost:5173/":        tool.EvidenceSmoke,
		"wget -qO- http://127.0.0.1:8000/health": tool.EvidenceSmoke,
		"npm run healthcheck":                    tool.EvidenceSmoke,
		"http get localhost":                     tool.EvidenceSmoke,
		// The strongest claim a command supports.
		"bunx vitest run e2e/":                     tool.EvidenceBehavior,
		"npm run build && npm run e2e":             tool.EvidenceBehavior,
		"npm run build && curl -sf localhost:3000": tool.EvidenceSmoke,
		"npm run e2e && curl -sf localhost:3000":   tool.EvidenceBehavior,
		"bun run test && bun run typecheck":        tool.EvidenceTests,
		"make check test":                          tool.EvidenceTests,
		"make test":                                tool.EvidenceTests,
	} {
		if got := ClassifyVerification(command); got != want {
			t.Errorf("ClassifyVerification(%q) = %q, want %q", command, got, want)
		}
	}
}

func TestVerificationTarget(t *testing.T) {
	// Expected values from the JavaScript /^\s*cd\s+(?:[^&\n|;]|\&(?!\&))+&&\s*/ in Node.
	for command, want := range map[string]string{
		"cd a && b":         "b",
		"cd  && b":          "b",
		"cd   && b":         "b",
		"cd \n && b":        "b",
		"cd a&b && c":       "c",
		"cd a | b && c":     "cd a | b && c",
		"cd\n a && b":       "b",
		"cd && b":           "cd && b",
		"  cd x &&  y":      "y",
		"cd a && cd b && c": "c",
		"cdx a && b":        "cdx a && b",
		"cd a; b && c":      "cd a; b && c",
	} {
		if got := VerificationTarget(command); got != want {
			t.Errorf("VerificationTarget(%q) = %q, want %q", command, got, want)
		}
	}
}

func TestRunsInlineAssertion(t *testing.T) {
	for command, want := range map[string]bool{
		`python3 -c "import m; assert m.f() == 2"`:      true,
		`node -e "require('assert').strictEqual(1, 1)"`: true,
		`node -e "console.assert(f() === 2)"`:           true,
		`python3 -c "print('assertion')"`:               false,
		`python3 -c "print(1)"`:                         false,
		"python3 script_with_assert.py":                 false,
		`cd /x && /usr/bin/python3 -c "assert True"`:    true,
	} {
		if got := RunsInlineAssertion(command); got != want {
			t.Errorf("RunsInlineAssertion(%q) = %v", command, got)
		}
	}
}

func TestRunsWrittenScript(t *testing.T) {
	written := map[string]bool{"code_example.py": true, "scripts/run.js": true}
	for command, want := range map[string]bool{
		"python3 code_example.py":                     true,
		"cd /home/chris && python3 ./code_example.py": true,
		"node /home/chris/scripts/run.js --flag":      true,
		"python3 other.py":                            false,
		"cat code_example.py":                         false,
	} {
		if got := RunsWrittenScript(command, written); got != want {
			t.Errorf("RunsWrittenScript(%q) = %v", command, got)
		}
	}
	if RunsWrittenScript("python3 code_example.py", map[string]bool{}) {
		t.Error("no written files")
	}
}

func TestRejectedVerificationReason(t *testing.T) {
	cases := []struct{ command, stdout, stderr, want string }{
		{"cd x && echo ok", "", "", "the command only prints text"},
		{"printf done", "", "", "the command only prints text"},
		{"npm test", "No tests found", "", "the command reported that no real build or test ran"},
		{"make", "", "nothing to build", "the command reported that no real build or test ran"},
		{"pytest", "0 tests run", "", "the command reported that no real build or test ran"},
		{"npm test", "5 passed", "", ""},
	}
	for _, c := range cases {
		if got := RejectedVerificationReason(c.command, c.stdout, c.stderr); got != c.want {
			t.Errorf("RejectedVerificationReason(%q, %q, %q) = %q, want %q", c.command, c.stdout, c.stderr, got, c.want)
		}
	}
}

func TestIsLikelyPersistentCommand(t *testing.T) {
	for command, want := range map[string]bool{
		"wc -l -w -c file.txt":                  false,
		"grep -w word file":                     false,
		"printf 'a b' > /tmp/x && wc -w /tmp/x": false,
		"ls -w 80":                              false,
		"npx jest -w 4":                         false,
		"jest --ci -w 2":                        false,
		"tsc -w":                                true,
		"vitest --watch":                        true,
		"npm run dev":                           true,
		"jest --watch src":                      true,
		"nodemon -w src app.js":                 true,
		"npx webpack -w":                        true,
		"npm start":                             true,
		"next dev":                              true,
		"bun run --hot x.ts":                    true,
		"timeout 5 npm run dev":                 false,
		"npm run dev & sleep 2 && curl localhost:3000 && kill %1": false,
	} {
		if got := IsLikelyPersistentCommand(command); got != want {
			t.Errorf("IsLikelyPersistentCommand(%q) = %v, want %v", command, got, want)
		}
	}
}
