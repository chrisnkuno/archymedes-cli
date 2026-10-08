import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FREE_HEALTH_WINDOW_MS, fileFreeHealthStore, freeHealthFile, FreeHealthTracker, healthScore, healthWeight, orderByFreeHealth, parseFreeHealth, recordFreeOutcome,
  type FreeHealthRecords,
} from "./free-health";

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 24 * 60 * 60 * 1000;
const models = [{ id: "a:free" }, { id: "b:free" }, { id: "c:free" }];

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe("free model health ranking", () => {
  it("keeps the incoming (preference) order with no history", () => {
    expect(orderByFreeHealth(models, {}, NOW)).toEqual(models);
  });

  it("puts recently successful models first and failing ones last, without dropping any", () => {
    let records: FreeHealthRecords = {};
    records = recordFreeOutcome(records, "a:free", { ok: false, reason: "HTTP 429" }, NOW);
    records = recordFreeOutcome(records, "c:free", { ok: true }, NOW);
    expect(orderByFreeHealth(models, records, NOW).map((model) => model.id)).toEqual(["c:free", "b:free", "a:free"]);
    expect(records["a:free"]).toMatchObject({ failures: 1, successes: 0, lastFailure: "HTTP 429" });
  });

  it("forgets outcomes over about a week, so no model is excluded for good", () => {
    const records = recordFreeOutcome({}, "a:free", { ok: false, reason: "timeout" }, NOW);
    expect(healthWeight(records["a:free"], NOW + 3.5 * DAY)).toBeCloseTo(0.5);
    expect(healthScore(records["a:free"], NOW + FREE_HEALTH_WINDOW_MS)).toBe(0.5);
    expect(orderByFreeHealth(models, records, NOW + 8 * DAY)).toEqual(models);
    // Expired records are pruned on the next write.
    expect(Object.keys(recordFreeOutcome(records, "b:free", { ok: true }, NOW + 8 * DAY))).toEqual(["b:free"]);
  });

  it("decays old counts before adding a new outcome, and keeps the last failure reason through a success", () => {
    let records = recordFreeOutcome({}, "a:free", { ok: false, reason: "HTTP 503" }, NOW);
    records = recordFreeOutcome(records, "a:free", { ok: true }, NOW + 3.5 * DAY);
    expect(records["a:free"]).toMatchObject({ successes: 1, failures: 0.5, lastFailure: "HTTP 503", updatedAt: NOW + 3.5 * DAY });
    expect(healthScore(records["a:free"], NOW + 3.5 * DAY)).toBeGreaterThan(0.5);
  });

  it("parses only well-formed records", () => {
    expect(parseFreeHealth({ models: {
      "a:free": { successes: 2, failures: 1, updatedAt: NOW, lastFailure: "HTTP\n404" },
      "b:free": { successes: "2", failures: 1, updatedAt: NOW },
      "c:free": null,
    } })).toEqual({ "a:free": { successes: 2, failures: 1, updatedAt: NOW, lastFailure: "HTTP 404" } });
    expect(parseFreeHealth("nope")).toEqual({});
  });

  it("persists through a file in the config directory and survives a corrupt one", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "archymedes-health-"));
    const file = freeHealthFile({ ARCHYMEDES_CONFIG_DIR: root });
    expect(path.basename(file)).toBe("free-health.json");
    const tracker = new FreeHealthTracker(fileFreeHealthStore(file), () => NOW);
    await tracker.record("a:free", { ok: true });
    await tracker.record("a:free", { ok: false, reason: "timeout" });
    expect(await tracker.records()).toEqual({ "a:free": { successes: 1, failures: 1, updatedAt: NOW, lastFailure: "timeout" } });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });
    await writeFile(file, "{broken");
    expect(await tracker.records()).toEqual({});
  });

  it("never throws when the store fails", async () => {
    const tracker = new FreeHealthTracker({ read: async () => { throw new Error("read"); }, write: async () => { throw new Error("write"); } }, () => NOW);
    await expect(tracker.record("a:free", { ok: true })).resolves.toBeUndefined();
    await expect(tracker.records()).resolves.toEqual({});
  });
});
