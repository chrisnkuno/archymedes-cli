package policy

import "testing"

func TestIsReadOnlyCommandAccepts(t *testing.T) {
	for _, command := range []string{
		"ls -la src",
		"cat package.json",
		"head -n 40 src/app.ts",
		"tail -n 100 build.log",
		"wc -l src/*.ts",
		"rg -n 'TODO' src",
		`grep -rn "useState" src | head -20`,
		"find . -name '*.go' -not -path './vendor/*'",
		"sed -n '1,80p' src/app.ts",
		"git status --short",
		"git diff HEAD~1 -- src",
		"git log --oneline -20",
		"git -C packages/core show HEAD:package.json",
		"git branch -a",
		"git branch --show-current",
		"git config --get user.name",
		"git stash list",
		"cd src && ls",
		"node --version",
		"command -v rg",
		"cat a.txt 2>/dev/null || echo missing",
		"git diff 2>&1 | head",
		"rg 'a>b' src",
		"echo '$(not run)'",
		"ls >/dev/null 2>/dev/null",
		"git remote get-url origin",
		"git tag -l",
		"printenv",
	} {
		if !IsReadOnlyCommand(command, "linux") {
			t.Errorf("IsReadOnlyCommand(%q) = false", command)
		}
	}
}

func TestIsReadOnlyCommandRefuses(t *testing.T) {
	for _, command := range []string{
		"",
		"rm -rf dist",
		"echo hi > out.txt",
		"cat a >> b",
		"sort -o sorted.txt list.txt",
		"uniq in.txt out.txt",
		"tail -f server.log",
		"sed -i 's/a/b/' file",
		"sed -n 'w out' file",
		"find . -name '*.tmp' -delete",
		`find . -exec rm {} \;`,
		"ls $(cat list)",
		"ls `pwd`",
		`echo "$(whoami)"`,
		"FOO=1 ls",
		"npm test",
		"npm install",
		"./script.sh --version",
		"git commit -m x",
		"git branch new-feature",
		"git branch -D old",
		"git tag v1",
		"git config user.name me",
		"git -c diff.external=evil diff",
		"git diff --output=patch.diff",
		"git stash",
		"git stash pop",
		"git worktree add ../x",
		"cat <<EOF\nhi\nEOF",
		"sleep 100 &",
		"ls | xargs rm",
		"cat file | tee copy",
		"rg --pre ./run.sh x",
		"env rm -rf x",
		"date -s 2020-01-01",
		"hostname newname",
		"cat 'unbalanced",
		"ls >/dev/nullx",
		"diff <(ls a) <(ls b)",
	} {
		if IsReadOnlyCommand(command, "linux") {
			t.Errorf("IsReadOnlyCommand(%q) = true", command)
		}
	}
}

func TestStripHarmlessRedirects(t *testing.T) {
	for in, want := range map[string]string{
		"cat a 2>/dev/null":            "cat a ",
		"cat a >/dev/null 2>&1":        "cat a  ",
		"cat a 2>/dev/null >/dev/null": "cat a  ",
		"cat a >/dev/nullx":            "cat a >/dev/nullx",
		"cat a 2>&1x":                  "cat a 2>&1x",
		">/dev/null cat":               " cat",
	} {
		if got := stripHarmlessRedirects(in); got != want {
			t.Errorf("stripHarmlessRedirects(%q) = %q, want %q", in, got, want)
		}
	}
}
