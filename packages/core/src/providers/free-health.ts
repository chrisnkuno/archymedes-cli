/**
 * Which free models have actually been answering on this machine lately.
 *
 * The free router's static preference list was right on the day it was probed; a week later one of
 * those models is overloaded or gated and every turn spends its first attempt (and up to 45 seconds)
 * finding that out again. So each candidate's recent successes and failures are kept in a small
 * JSON file beside the usage meter, and the router tries the ones that have been working first.
 *
 * Counts decay linearly to nothing over `FREE_HEALTH_WINDOW_MS` (about a week), so an old outage is
 * forgotten and a model is never excluded for good — a failing model only moves down the list, and
 * a model with no recent history keeps its place from the static preference. Like the usage meter,
 * nothing here may fail a model call: an unreadable or unwritable file means no ranking, not an error.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { archymedesConfigDirectory } from "../cli/memory";

export const FREE_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded so a long-lived file cannot grow with every model OpenRouter ever listed. */
const MAX_MODELS = 64;

export type FreeModelHealth = { successes: number; failures: number; lastFailure?: string; updatedAt: number };
export type FreeHealthRecords = Record<string, FreeModelHealth>;
export type FreeHealthStore = { read(): Promise<FreeHealthRecords>; write(records: FreeHealthRecords): Promise<void> };

export function freeHealthFile(environment: Record<string, string | undefined> = process.env): string {
  return path.join(archymedesConfigDirectory(environment), "free-health.json");
}

/** Only well-formed records survive a read; a failure reason is bounded and stripped of control characters. */
export function parseFreeHealth(value: unknown): FreeHealthRecords {
  const models = value && typeof value === "object" && !Array.isArray(value) ? (value as { models?: unknown }).models : undefined;
  if (!models || typeof models !== "object" || Array.isArray(models)) return {};
  const parsed: FreeHealthRecords = {};
  const count = (item: unknown) => typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : undefined;
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || id.length > 256) continue;
    const row = raw as Record<string, unknown>;
    const successes = count(row.successes);
    const failures = count(row.failures);
    const updatedAt = count(row.updatedAt);
    if (successes === undefined || failures === undefined || updatedAt === undefined) continue;
    const lastFailure = typeof row.lastFailure === "string" ? row.lastFailure.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 120) : undefined;
    parsed[id] = { successes, failures, updatedAt, ...(lastFailure ? { lastFailure } : {}) };
  }
  return parsed;
}

/** How much of a record's counts still count at `now`: 1 when fresh, 0 after the window. */
export function healthWeight(record: Pick<FreeModelHealth, "updatedAt">, now: number): number {
  const age = Math.max(0, now - record.updatedAt);
  return Math.max(0, 1 - age / FREE_HEALTH_WINDOW_MS);
}

/**
 * A record's success rate with a neutral prior: 0.5 for a model with no recent history, rising with
 * decayed successes and falling with decayed failures, never reaching 0 or 1.
 */
export function healthScore(record: FreeModelHealth | undefined, now: number): number {
  if (!record) return 0.5;
  const weight = healthWeight(record, now);
  return (record.successes * weight + 1) / ((record.successes + record.failures) * weight + 2);
}

/** Adds one outcome to a record, decaying what was there first, and drops expired records. */
export function recordFreeOutcome(records: FreeHealthRecords, id: string, outcome: { ok: true } | { ok: false; reason: string }, now: number): FreeHealthRecords {
  const kept: FreeHealthRecords = {};
  for (const [key, record] of Object.entries(records)) if (healthWeight(record, now) > 0) kept[key] = record;
  const previous = kept[id];
  const weight = previous ? healthWeight(previous, now) : 0;
  const successes = (previous?.successes ?? 0) * weight + (outcome.ok ? 1 : 0);
  const failures = (previous?.failures ?? 0) * weight + (outcome.ok ? 0 : 1);
  const lastFailure = outcome.ok ? previous?.lastFailure : outcome.reason.slice(0, 120);
  kept[id] = { successes: Math.round(successes * 1000) / 1000, failures: Math.round(failures * 1000) / 1000, updatedAt: now, ...(lastFailure ? { lastFailure } : {}) };
  const newest = Object.entries(kept).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, MAX_MODELS);
  return Object.fromEntries(newest);
}

/**
 * `models` reordered by recent health, best first. Ties (including every model with no history)
 * keep their incoming order, which is the static preference — so with an empty file this is the
 * identity, and nothing is ever removed.
 */
export function orderByFreeHealth<T extends { id: string }>(models: readonly T[], records: FreeHealthRecords, now: number): T[] {
  return models
    .map((model, index) => ({ model, index, score: healthScore(records[model.id], now) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ model }) => model);
}

/** A JSON file replaced atomically; a missing or corrupt one reads as no history. */
export function fileFreeHealthStore(file: string): FreeHealthStore {
  return {
    async read() {
      try { return parseFreeHealth(JSON.parse(await fs.readFile(file, "utf8"))); } catch { return {}; }
    },
    async write(models) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ version: 1, models }, null, 2)}\n`);
        await fs.rename(temporary, file);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

/** Reads and records outcomes; serialized in-process, and never throws. */
export class FreeHealthTracker {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: FreeHealthStore, private readonly now: () => number = Date.now) {}

  async records(): Promise<FreeHealthRecords> {
    await this.tail;
    return this.store.read().catch((): FreeHealthRecords => ({}));
  }

  record(id: string, outcome: { ok: true } | { ok: false; reason: string }): Promise<void> {
    const work = this.tail.then(async () => {
      const records = await this.store.read().catch((): FreeHealthRecords => ({}));
      await this.store.write(recordFreeOutcome(records, id, outcome, this.now())).catch(() => undefined);
    });
    this.tail = work.catch(() => undefined);
    return work.catch(() => undefined);
  }
}
