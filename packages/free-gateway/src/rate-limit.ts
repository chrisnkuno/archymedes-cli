/**
 * Fixed-window request counters for the shared free key. OpenRouter's free quota belongs to one
 * account, so a global ceiling protects every user from one heavy client, and a per-IP ceiling keeps
 * that from being one person. Counters fail closed: if the store is unreachable, nothing is sent.
 */
import { createHash } from "node:crypto";

export interface CounterStore {
  /** Adds one to `key`, creating it with `ttlMs` to live, and returns the new count. */
  increment(key: string, ttlMs: number): Promise<number>;
}

export type RateRule = { name: string; scope: "ip" | "global"; windowMs: number; limit: number };

export type RateDecision = { ok: true } | { ok: false; rule: string; retryAfterMs: number };

/** Single-instance store. Bounded so a flood of distinct IPs cannot exhaust memory. */
export class MemoryCounterStore implements CounterStore {
  private readonly counts = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly maxKeys = 100_000, private readonly now: () => number = Date.now) {}

  async increment(key: string, ttlMs: number): Promise<number> {
    const now = this.now();
    const existing = this.counts.get(key);
    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      return existing.count;
    }
    if (this.counts.size >= this.maxKeys) {
      for (const [stale, entry] of this.counts) if (entry.expiresAt <= now) this.counts.delete(stale);
      // Still full of live windows: drop the oldest insertion rather than grow without bound.
      while (this.counts.size >= this.maxKeys) this.counts.delete(this.counts.keys().next().value!);
    }
    this.counts.set(key, { count: 1, expiresAt: now + ttlMs });
    return 1;
  }
}

/** Shared store for several instances, over Upstash's REST pipeline (no client library needed). */
export function upstashCounterStore(url: string, token: string, fetchImpl: typeof fetch = fetch): CounterStore {
  return {
    async increment(key, ttlMs) {
      const response = await fetchImpl(`${url.replace(/\/$/, "")}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify([["INCR", key], ["PEXPIRE", key, String(ttlMs), "NX"]]),
      });
      if (!response.ok) throw new Error(`Counter store returned HTTP ${response.status}`);
      const [first] = await response.json() as Array<{ result?: unknown; error?: string }>;
      if (typeof first?.result !== "number") throw new Error("Counter store returned no count");
      return first.result;
    },
  };
}

/** Raw addresses are never stored; a salted hash is enough to count them. */
export function clientKey(ip: string | undefined, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip ?? "unknown"}`).digest("base64url").slice(0, 22);
}

/**
 * Per-address rules are charged first and global rules only if those pass, so one client hammering
 * past its own limit cannot also drain the shared capacity everyone else depends on.
 */
export async function consume(store: CounterStore, rules: readonly RateRule[], client: string, now: number): Promise<RateDecision> {
  for (const scope of ["ip", "global"] as const) {
    let denied: RateDecision = { ok: true };
    for (const rule of rules.filter((candidate) => candidate.scope === scope)) {
      const window = Math.floor(now / rule.windowMs);
      const count = await store.increment(`free:${rule.name}:${scope === "global" ? "all" : client}:${window}`, rule.windowMs);
      const retryAfterMs = rule.windowMs - (now % rule.windowMs);
      if (count > rule.limit && (denied.ok || retryAfterMs > denied.retryAfterMs)) denied = { ok: false, rule: rule.name, retryAfterMs };
    }
    if (!denied.ok) return denied;
  }
  return { ok: true };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Defaults sized to OpenRouter's documented free-model limits for a funded account (about 20
 * requests a minute and 1,000 a day, checked 2026-09-15). An agent task is often 5-20 requests,
 * so these are small; operators should set them from their own account's limits.
 */
export function rulesFrom(environment: Record<string, string | undefined>): RateRule[] {
  const number = (name: string, fallback: number) => {
    const value = Number(environment[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return [
    { name: "ip-minute", scope: "ip", windowMs: MINUTE, limit: number("FREE_GATEWAY_IP_PER_MINUTE", 10) },
    { name: "ip-day", scope: "ip", windowMs: DAY, limit: number("FREE_GATEWAY_IP_PER_DAY", 150) },
    { name: "global-minute", scope: "global", windowMs: MINUTE, limit: number("FREE_GATEWAY_GLOBAL_PER_MINUTE", 20) },
    { name: "global-day", scope: "global", windowMs: DAY, limit: number("FREE_GATEWAY_GLOBAL_PER_DAY", 1_000) },
  ];
}
