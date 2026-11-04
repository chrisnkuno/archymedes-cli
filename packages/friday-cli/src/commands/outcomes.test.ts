import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../cli/args";
import { readOutcomeState, recordTaskOutcome } from "../platform/outcome-reporting";
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
    expect(await runOutcomesCommand({ kind: "on" }, { ...io, confirm: async () => true })).toBe(0);
    expect(written).toMatch(/is on/i);
    written = "";
    expect(await runOutcomesCommand({ kind: "preview" }, io)).toBe(0);
    expect(JSON.parse(written.slice(written.indexOf("{")))).toHaveProperty("events");
    written = "";
    expect(await runOutcomesCommand({ kind: "off" }, io)).toBe(0);
    expect(written).toMatch(/erasure/i);
    expect(await runOutcomesCommand({ kind: "invalid", reason: "bad" }, io)).toBe(2);
  });

  describe("consent", () => {
    const quiet = (extra: object = {}) => {
      const log = { text: "" };
      return { log, io: { environment: {}, directory, write: (text: string) => { log.text += text; }, fetch: (async () => { throw new Error("no network"); }) as typeof fetch, ...extra } };
    };

    it("refuses to turn on without a person to ask, and changes nothing", async () => {
      const { log, io } = quiet();
      expect(await runOutcomesCommand({ kind: "on" }, io)).toBe(5);
      expect(log.text).toMatch(/cannot be turned on from a script/);
      expect((await readOutcomeState(io)).enabled).toBe(false);
      expect(await recordTaskOutcome({ engine: "archymedes", provider: "openai", model: "gpt-4o", status: "completed", toolCalls: 1, iterations: 1, elapsedMs: 1 }, io)).toBe("off");
    });

    it("turns on only for an explicit yes, and a no changes nothing", async () => {
      const no = quiet({ confirm: async () => false });
      expect(await runOutcomesCommand({ kind: "on" }, no.io)).toBe(0);
      expect(no.log.text).toMatch(/stays off/);
      expect((await readOutcomeState(no.io)).enabled).toBe(false);
      const yes = quiet({ confirm: async () => true });
      expect(await runOutcomesCommand({ kind: "on" }, yes.io)).toBe(0);
      expect((await readOutcomeState(yes.io)).enabled).toBe(true);
    });

    it("does not ask again once consent exists, even without a terminal, and off always works", async () => {
      await runOutcomesCommand({ kind: "on" }, quiet({ confirm: async () => true }).io);
      const again = quiet();
      expect(await runOutcomesCommand({ kind: "on" }, again.io)).toBe(0);
      expect(again.log.text).toMatch(/already on/);
      expect(await runOutcomesCommand({ kind: "off" }, again.io)).toBe(0);
      expect((await readOutcomeState(again.io)).enabled).toBe(false);
    });

    it("explains what is collected before asking", async () => {
      let asked = "";
      const { log, io } = quiet({ confirm: async (question: string) => { asked = question; return false; } });
      await runOutcomesCommand({ kind: "on" }, io);
      expect(log.text).toMatch(/Never prompts, code, paths/);
      expect(log.text).toMatch(/reported only as "custom"/);
      expect(asked).toMatch(/\[y\/N\]/);
    });
  });
});
