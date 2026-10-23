import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLAYBOOK_DIR, playbookFiles } from "./export-playbooks";

describe("defender playbooks for the Go engine", () => {
  it("match the TypeScript catalog file for file (run: bun run tooling/build/export-playbooks.ts)", () => {
    const want = playbookFiles();
    const have = readdirSync(PLAYBOOK_DIR).filter((name) => name.endsWith(".md")).sort();
    expect(have).toEqual(want.map((file) => file.name));
    for (const file of want) expect(readFileSync(path.join(PLAYBOOK_DIR, file.name), "utf8")).toBe(file.text);
  });
});
