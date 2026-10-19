import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "./command-readonly";

const readOnly = (command: string) => isReadOnlyCommand(command, "linux");

describe("isReadOnlyCommand", () => {
  it("accepts the commands agents use to look around", () => {
    for (const command of [
      "ls -la src",
      "cat package.json",
      "head -n 40 src/app.ts",
      "tail -n 100 build.log",
      "wc -l src/*.ts",
      "rg -n 'TODO' src",
      "grep -rn \"useState\" src | head -20",
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
    ]) expect(readOnly(command), command).toBe(true);
  });

  it("refuses anything that writes, runs something else, or cannot be accounted for", () => {
    for (const command of [
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
      "find . -exec rm {} \\;",
      "ls $(cat list)",
      "ls `pwd`",
      "echo \"$(whoami)\"",
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
    ]) expect(readOnly(command), command).toBe(false);
  });
});
