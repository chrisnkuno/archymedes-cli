import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "./backends";
import { listPrefix, searchTools } from "./tools-search";

describe("the search tool family", () => {
  it("is read-only, parallel-safe and in contract order", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-search-"));
    try {
      const tools = searchTools(new LocalWorkspace(root));
      expect(tools.map((tool) => tool.name)).toEqual(["list_files", "glob_files", "grep_files", "scan_secrets"]);
      expect(tools.every((tool) => tool.effect === "none" && tool.parallelSafe && !tool.requiresApproval)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reads './src/', '.' and an absolute path inside the root as the same root-relative prefix", () => {
    expect(listPrefix("./src/", null)).toBe("src");
    expect(listPrefix(".", "/project")).toBe("");
    expect(listPrefix("/project/src", "/project")).toBe("src");
  });
});
