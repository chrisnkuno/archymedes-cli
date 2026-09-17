import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSlashInput } from "./slash-input";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-slash-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function context() {
  const dims: string[] = [];
  const warnings: string[] = [];
  return {
    dims, warnings,
    value: { root, environment: { ARCHYMEDES_CONFIG_DIR: path.join(root, "config") }, dim: (t: string) => dims.push(t), warn: (h: string, d: string) => warnings.push(h + d) },
  };
}

describe("typed slash input that is not a built-in", () => {
  it("becomes the saved prompt, and says which file it came from", async () => {
    await fs.mkdir(path.join(root, ".archymedes", "commands"), { recursive: true });
    await fs.writeFile(path.join(root, ".archymedes", "commands", "explain.md"), "Explain $ARGUMENTS simply.");
    const c = context();
    expect(await resolveSlashInput("/explain the cache layer", c.value)).toBe("Explain the cache layer simply.");
    expect(c.dims[0]).toContain("/explain · project command");
    expect(c.warnings).toEqual([]);
  });

  it("is reported as unknown, with a built-in suggestion and the custom commands that do exist", async () => {
    await fs.mkdir(path.join(root, ".archymedes", "commands"), { recursive: true });
    await fs.writeFile(path.join(root, ".archymedes", "commands", "explain.md"), "Explain.");
    const c = context();
    expect(await resolveSlashInput("/hepl", c.value)).toBeUndefined();
    expect(c.warnings[0]).toContain("Unknown command /hepl.");
    expect(c.warnings[0]).toContain("Did you mean /help?");
    expect(c.warnings[0]).toContain("Custom: /explain.");
  });
});
