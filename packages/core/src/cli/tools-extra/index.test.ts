import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSupportedSchema, validateToolArguments, type ToolInputSchema } from "../tool-schema";
import { createExtraTools, SymbolIndex } from "./index";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-extra-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("createExtraTools", () => {
  it("returns every extra tool with a schema the core validator accepts", () => {
    const tools = createExtraTools({ root });
    expect(tools.map((tool) => tool.name)).toEqual(["repo_map", "find_symbol", "git_status", "git_diff", "git_log", "git_show", "notebook_edit", "view_image"]);
    for (const tool of tools) {
      expect(() => assertSupportedSchema(tool.name, tool.inputSchema)).not.toThrow();
      expect(tool.description.length).toBeGreaterThan(40);
      expect(typeof tool.capabilityId).toBe("string");
    }
  });

  it("declares effects and parallel safety as the runtime expects", () => {
    const byName = new Map(createExtraTools({ root }).map((tool) => [tool.name, tool]));
    for (const name of ["repo_map", "find_symbol", "git_status", "git_diff", "git_log", "git_show", "view_image"]) {
      expect(byName.get(name)).toMatchObject({ effect: "none", parallelSafe: true, requiresApproval: false, capabilityId: "workspace.files.read" });
    }
    expect(byName.get("notebook_edit")).toMatchObject({ effect: "workspace", parallelSafe: false, requiresApproval: true, capabilityId: "workspace.files" });
  });

  it("schemas reject unknown and mistyped arguments", () => {
    const repoMap = createExtraTools({ root }).find((tool) => tool.name === "repo_map")!;
    const schema = repoMap.inputSchema as ToolInputSchema;
    expect(() => validateToolArguments("repo_map", schema, { bogus: 1 })).toThrow();
    expect(() => validateToolArguments("repo_map", schema, { maxChars: "lots" })).toThrow();
    expect(validateToolArguments("repo_map", schema, { path: "src", maxChars: 5000 })).toEqual({ path: "src", maxChars: 5000 });
  });

  it("shares one symbol cache between repo_map and find_symbol", async () => {
    await fs.writeFile(path.join(root, "a.py"), "def one():\n    pass\n");
    const index = new SymbolIndex(root);
    const tools = createExtraTools({ root, symbolIndex: index, ripgrep: null });
    const context = { taskId: "t", runId: "r", stepId: "s" };
    await tools.find((tool) => tool.name === "repo_map")!.execute({}, context);
    await tools.find((tool) => tool.name === "find_symbol")!.execute({ name: "one" }, context);
    expect(index.parsedCount).toBe(1);
  });
});
