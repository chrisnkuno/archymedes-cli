/**
 * Free mode's token meter: how much of today's allowance this machine has spent, and what the
 * gateway says is left.
 *
 * The hosted free gateway grants each install a fixed daily token allowance (100,000 tokens and 25
 * requests by default), and an agent turn is several requests, each resending the whole
 * conversation. Without a meter the first sign of the limit is the 429 that ends the day's work, so
 * two independent numbers are kept:
 *
 * - **A local count**, per UTC day, in the config directory beside the install token. It is the
 *   only number available with the user's own OpenRouter key (no gateway, no headers), and it
 *   survives restarts so "today" means today rather than "this process".
 * - **The gateway's own figure**, from `x-free-remaining-tokens` / `x-free-reset-utc` /
 *   `x-free-allowance-warning`. Those headers describe the allowance at the *start* of the request
 *   (the gateway charges a streamed reply while forwarding it), so the request's own measured total
 *   is subtracted to say what is left after it.
 *
 * Neither may ever fail a model call: a meter that cannot write its file under-counts, it does not
 * stop the work it is counting.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelAllowance } from "../agent-runtime";
import { archymedesConfigDirectory } from "../cli/memory";

export const FREE_REMAINING_TOKENS_HEADER = "x-free-remaining-tokens";
export const FREE_RESET_UTC_HEADER = "x-free-reset-utc";
export const FREE_ALLOWANCE_WARNING_HEADER = "x-free-allowance-warning";
/** Requests left today, before this request (like the token figure); absent from older gateways. */
export const FREE_REMAINING_REQUESTS_HEADER = "x-free-remaining-requests";
/** Days kept in the file; older ones are dropped on the next write. */
const KEPT_DAYS = 7;

type HeaderBag = { get?(name: string): string | null } | undefined;

/** The allowance facts one gateway response carried, before this request's own usage is subtracted. */
export type FreeAllowanceHeaders = { remainingTokens?: number; remainingRequests?: number; resetsAt?: string; warning?: string };

/** The UTC calendar day of a timestamp, as `YYYY-MM-DD` — the key the gateway's allowance resets on. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The allowance headers of one gateway response, or undefined when it carried none.
 *
 * Every field is validated on its own: a malformed count is dropped rather than read as zero (which
 * would announce an exhausted day that is not), and a reset that is not a timestamp is dropped
 * rather than shown. The warning is bounded and stripped of control characters, because it is
 * printed into the terminal verbatim.
 */
export function parseFreeAllowanceHeaders(headers: HeaderBag): FreeAllowanceHeaders | undefined {
  const read = (name: string) => headers?.get?.(name)?.trim() || undefined;
  const remainingText = read(FREE_REMAINING_TOKENS_HEADER);
  const remaining = remainingText !== undefined && /^\d{1,12}$/.test(remainingText) ? Number(remainingText) : undefined;
  const requestsText = read(FREE_REMAINING_REQUESTS_HEADER);
  const requests = requestsText !== undefined && /^\d{1,9}$/.test(requestsText) ? Number(requestsText) : undefined;
  const resetText = read(FREE_RESET_UTC_HEADER);
  const resetsAt = resetText && resetText.length <= 64 && Number.isFinite(Date.parse(resetText)) ? new Date(Date.parse(resetText)).toISOString() : undefined;
  const warning = read(FREE_ALLOWANCE_WARNING_HEADER)?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 200) || undefined;
  if (remaining === undefined && requests === undefined && !resetsAt && !warning) return undefined;
  return {
    ...(remaining !== undefined ? { remainingTokens: remaining } : {}),
    ...(requests !== undefined ? { remainingRequests: requests } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * Where the day stands after a call that spent `spentTokens`.
 *
 * The gateway's remaining figure is pre-request, so this call's total comes off it; floored at zero
 * because the gateway lets the request that crosses the line finish.
 */
export function allowanceAfterCall(day: { date: string; usedTokens: number }, gateway: FreeAllowanceHeaders | undefined, spentTokens: number): ModelAllowance {
  return {
    ...day,
    ...(gateway?.remainingTokens !== undefined ? { remainingTokens: Math.max(0, gateway.remainingTokens - Math.max(0, spentTokens)) } : {}),
    // Pre-request as well: this request was one of them.
    ...(gateway?.remainingRequests !== undefined ? { remainingRequests: Math.max(0, gateway.remainingRequests - 1) } : {}),
    ...(gateway?.resetsAt ? { resetsAt: gateway.resetsAt } : {}),
    ...(gateway?.warning ? { warning: gateway.warning } : {}),
  };
}

/** `950`, `12.3k`, `1.2M`: a token count short enough for a status line. */
export function compactTokenCount(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value < 1_000) return String(value);
  if (value < 999_950) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** `00:00 UTC` for an ISO timestamp, or undefined when it is not one. */
export function formatResetUtc(resetsAt: string | undefined): string | undefined {
  const time = Date.parse(resetsAt ?? "");
  if (!Number.isFinite(time)) return undefined;
  return `${new Date(time).toISOString().slice(11, 16)} UTC`;
}

/** `287 req left`, or `47/50 req left` when the day's limit is known. */
export function formatRequestsLeft(allowance: Pick<ModelAllowance, "remainingRequests" | "requestLimit">): string | undefined {
  if (allowance.remainingRequests === undefined) return undefined;
  return allowance.requestLimit !== undefined ? `${allowance.remainingRequests}/${allowance.requestLimit} req left` : `${allowance.remainingRequests} req left`;
}

/**
 * The one-line meter: `today 12.3k tok · 87.7k left · 287 req left · resets 00:00 UTC`.
 *
 * A count from an earlier day reads as zero for today — the local file is keyed by date, so a
 * snapshot taken before midnight UTC must not be shown as this morning's spend.
 */
export function formatModelAllowance(allowance: ModelAllowance, now = Date.now()): string {
  const used = allowance.date === utcDay(now) ? allowance.usedTokens : 0;
  const reset = formatResetUtc(allowance.resetsAt);
  return [
    `today ${compactTokenCount(used)} tok`,
    ...(allowance.remainingTokens !== undefined ? [`${compactTokenCount(allowance.remainingTokens)} left`] : []),
    ...(allowance.remainingRequests !== undefined ? [formatRequestsLeft(allowance)!] : []),
    ...(reset ? [`resets ${reset}`] : []),
  ].join(" · ");
}

/** Per-day totals, by UTC date. */
export type FreeUsageDays = Record<string, number>;
export type FreeUsageStore = { read(): Promise<FreeUsageDays>; write(days: FreeUsageDays): Promise<void> };

export function freeUsageFile(environment: Record<string, string | undefined> = process.env): string {
  return path.join(archymedesConfigDirectory(environment), "free-usage.json");
}

/** Only well-formed `YYYY-MM-DD` keys with non-negative integer totals survive a read. */
export function parseFreeUsageDays(value: unknown): FreeUsageDays {
  const days = value && typeof value === "object" && !Array.isArray(value) ? (value as { days?: unknown }).days : undefined;
  if (!days || typeof days !== "object" || Array.isArray(days)) return {};
  const parsed: FreeUsageDays = {};
  for (const [date, total] of Object.entries(days as Record<string, unknown>)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof total === "number" && Number.isSafeInteger(total) && total >= 0) parsed[date] = total;
  }
  return parsed;
}

/** The newest `KEPT_DAYS` entries: the file never grows past a week of numbers. */
export function pruneFreeUsageDays(days: FreeUsageDays): FreeUsageDays {
  return Object.fromEntries(Object.entries(days).sort(([a], [b]) => b.localeCompare(a)).slice(0, KEPT_DAYS));
}

/** A JSON file replaced atomically; a missing or corrupt one reads as no usage yet. */
export function fileFreeUsageStore(file: string): FreeUsageStore {
  return {
    async read() {
      try { return parseFreeUsageDays(JSON.parse(await fs.readFile(file, "utf8"))); } catch { return {}; }
    },
    async write(days) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ version: 1, days }, null, 2)}\n`);
        await fs.rename(temporary, file);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

/**
 * Today's local token count, added to after every free model call.
 *
 * Writes are serialized within the process (tabs and delegated sub-runs share one provider) and
 * re-read the file each time, so two processes on one machine add to each other's count rather
 * than overwrite it — except in the rare overlapping write, which under-counts by one call.
 */
export class FreeUsageMeter {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: FreeUsageStore, private readonly now: () => number = Date.now) {}

  /** Adds `tokens` to today's total and returns it. Never throws: a failed write still returns the sum. */
  record(tokens: number): Promise<{ date: string; usedTokens: number }> {
    const work = this.tail.then(async () => {
      const date = utcDay(this.now());
      const days = await this.store.read().catch((): FreeUsageDays => ({}));
      const usedTokens = (days[date] ?? 0) + (Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0);
      await this.store.write(pruneFreeUsageDays({ ...days, [date]: usedTokens })).catch(() => undefined);
      return { date, usedTokens };
    });
    this.tail = work.catch(() => undefined);
    return work;
  }

  /** Today's total without adding to it. */
  async today(): Promise<{ date: string; usedTokens: number }> {
    const date = utcDay(this.now());
    const days = await this.store.read().catch((): FreeUsageDays => ({}));
    return { date, usedTokens: days[date] ?? 0 };
  }
}
