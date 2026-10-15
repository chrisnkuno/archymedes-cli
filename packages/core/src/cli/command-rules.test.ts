import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { forbiddenMessage, judgeCommand, loadCommandRules, parseCommandRules, splitCompound } from "./command-rules";

const rules = parseCommandRules(JSON.stringify({
  rules: [
    { prefix: ["git", "push"], decision: "ask", reason: "pushes are reviewed", match: ["git push origin main", ["git", "push"]], not_match: ["git pull"] },
    { prefix: ["rm", ["-rf", "-fr"]], decision: "forbid", reason: "Use trash-put instead.", match: ["rm -rf build", "rm -fr x"], not_match: ["rm build"] },
    { prefix: ["npm", ["test", "run"]], decision: "allow", match: ["npm test", "npm run lint"] },
  ],
}), "rules.json");

describe("command rules", () => {
  it("load when every example agrees with its rule", () => {
    expect(rules.problems).toEqual([]);
    expect(rules.rules).toHaveLength(3);
  });

  it("leave out a rule whose own examples disagree, and say which example and why", () => {
    const loaded = parseCommandRules(JSON.stringify({ rules: [
      { prefix: ["git", "push"], decision: "ask", match: ["git pull"] },
      { prefix: ["ls"], decision: "allow", not_match: ["ls -la"] },
      { prefix: [], decision: "allow" },
      { prefix: ["x"], decision: "maybe" },
      { prefix: ["make"], decision: "allow" },
    ] }), "p.json");
    expect(loaded.rules.map((rule) => rule.prefix)).toEqual([["make"]]);
    expect(loaded.problems).toEqual([
      'p.json rule 1 (git push): should match "git pull" but does not — left out',
      'p.json rule 2 (ls): should not match "ls -la" but does — left out',
      'p.json rule 3: "prefix" must be a non-empty list of words (or lists of alternative words)',
      'p.json rule 4: "decision" must be allow, ask or forbid',
    ]);
    expect(parseCommandRules("{", "bad.json").problems[0]).toMatch(/^bad.json: not valid JSON/);
  });

  it("judge a compound command part by part: forbid beats ask beats allow, allow needs every part", () => {
    expect(judgeCommand(rules.rules, "npm test")?.decision).toBe("allow");
    expect(judgeCommand(rules.rules, "npm test && git push")?.decision).toBe("ask");
    expect(judgeCommand(rules.rules, "npm test; rm -rf dist")?.decision).toBe("forbid");
    expect(judgeCommand(rules.rules, "npm test && ls")).toBeUndefined(); // ls is not covered by any rule
    expect(judgeCommand(rules.rules, "CI=1 /usr/bin/npm run build")?.decision).toBe("allow");
    expect(judgeCommand(rules.rules, "echo 'rm -rf /'")).toBeUndefined(); // quoted text is not a command
    expect(judgeCommand([], "rm -rf /")).toBeUndefined();
  });

  it("split on operators outside quotes only", () => {
    expect(splitCompound(`a && b || c; d | e\nf`)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(splitCompound(`echo "a && b" ; echo 'c|d'`)).toEqual([`echo "a && b"`, `echo 'c|d'`]);
  });

  it("tell the model why, and where the rule is", () => {
    const verdict = judgeCommand(rules.rules, "rm -rf build")!;
    expect(forbiddenMessage("rm -rf build", verdict)).toBe("Refused by a command rule (rm {-rf|-fr}, in rules.json): 'rm -rf build' is not run here. Use trash-put instead.");
  });
});

describe("loading command rules", () => {
  let root: string;
  let config: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "rules-"));
    config = await fs.mkdtemp(path.join(os.tmpdir(), "rules-config-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(config, { recursive: true, force: true });
  });

  it("reads the project's rules before the person's own, and no files are no rules", async () => {
    expect(await loadCommandRules(root, { ARCHYMEDES_CONFIG_DIR: config })).toEqual({ rules: [], problems: [] });
    await fs.mkdir(path.join(root, ".archymedes"));
    await fs.writeFile(path.join(root, ".archymedes", "rules.json"), JSON.stringify({ rules: [{ prefix: ["make"], decision: "forbid" }] }));
    await fs.writeFile(path.join(config, "rules.json"), JSON.stringify({ rules: [{ prefix: ["make"], decision: "allow" }] }));
    const loaded = await loadCommandRules(root, { ARCHYMEDES_CONFIG_DIR: config });
    expect(judgeCommand(loaded.rules, "make")?.decision).toBe("forbid");
  });
});
