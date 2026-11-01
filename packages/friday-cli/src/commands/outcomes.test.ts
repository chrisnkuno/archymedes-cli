import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../cli/args";
import { parseOutcomesCommand, runOutcomesCommand } from "./outcomes";

describe("friday outcomes", () => {
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "friday-outcomes-cmd-")); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it("parses on, off, status and preview, and defaults to status", () => {
    expect(parseOutcomesCommand([])).toEqual({ kind: "status" });
    for (const kind of ["on", "off", "status", "preview"] as const) expect(parseOutcomesCommand([kind])).toEqual({ kind });
    expect(parseOutcomesCommand(["maybe"])).toMatchObject({ kind: "invalid" });
    expect(parseArgs(["outcomes", "on"]).outcomesCommand).toEqual({ kind: "on" });
    expect(parseArgs(["outcomes"]).outcomesCommand).toEqual({ kind: "status" });
    expect(parseArgs(["fix", "the", "outcomes"]).outcomesCommand).toBeNull();
  });

  it("turns reporting on and off and says what it did", async () => {
    let written = "";
    const io = { environment: {}, directory, write: (text: string) => { written += text; }, fetch: (async () => { throw new Error("no network in this test"); }) as typeof fetch };
    expect(await runOutcomesCommand({ kind: "status" }, io)).toBe(0);
    expect(written).toMatch(/off/i);
    written = "";
    expect(await runOutcomesCommand({ kind: "on" }, io)).toBe(0);
    expect(written).toMatch(/on/i);
    written = "";
    expect(await runOutcomesCommand({ kind: "preview" }, io)).toBe(0);
    expect(JSON.parse(written.slice(written.indexOf("{")))).toHaveProperty("events");
    written = "";
    expect(await runOutcomesCommand({ kind: "off" }, io)).toBe(0);
    expect(written).toMatch(/erasure/i);
    expect(await runOutcomesCommand({ kind: "invalid", reason: "bad" }, io)).toBe(2);
  });
});
