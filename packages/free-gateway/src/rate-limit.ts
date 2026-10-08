/**
 * Fixed-window request counters for the shared free key. OpenRouter's free quota belongs to one
 * account, so a global ceiling protects every user from one heavy client, and a per-IP ceiling keeps
 * that from being one person. Counters fail closed: if the store is unreachable, nothing is sent.
 */
import { createHash } from "node:crypto";

export interface CounterStore {
  /** Adds one to `key`, creating it with `ttlMs` to live, and returns the new count. */
  increment(key: string, ttlMs: number): Promise<number>;
  /**
   * Adds `amount` to `key`, creating it with `ttlMs` to live, and returns the new
   * total. Atomic in every implementation, so concurrent callers can never read a
   * count between each other's additions — the property token accounting relies on.
   */
  add(key: string, amount: number, ttlMs: number): Promise<number>;
  /** The current count, or undefined when the key does not exist or has expired. */
  get(key: string): Promise<number | undefined>;
}

/**
 * Which counter a rule charges: the client's address, its install token's id (only when the
 * request carries a valid token), or the whole gateway.
 */
export type RateScope = "ip" | "install" | "global";

export type RateRule = { name: string; scope: RateScope; windowMs: number; limit: number };

/**
 * Who a request counts against. `ip` is always present (a salted hash, never the raw address);
 * `install` only when the request carried a valid install token.
 */
export type Identities = { ip: string; install?: string };

/** One counter a request was charged against, with its count including that request. */
export type RuleCount = { rule: RateRule; count: number };

/**
 * `counts` lists every counter this request incremented (in charge order) with its count
 * including this request, so callers can report what is left without another store read.
 * A denied request is refunded, so its counts describe the moment it was evaluated.
 */
export type RateDecision =
  | { ok: true; counts: RuleCount[] }
  | { ok: false; rule: string; scope: RateScope; retryAfterMs: number; limit: number; windowMs: number; counts: RuleCount[] };

/** Single-instance store. Bounded so a flood of distinct IPs cannot exhaust memory. */
export class MemoryCounterStore implements CounterStore {
  private readonly counts = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly maxKeys = 100_000, private readonly now: () => number = Date.now) {}

  async increment(key: string, ttlMs: number): Promise<number> {
    return this.add(key, 1, ttlMs);
  }

  async add(key: string, amount: number, ttlMs: number): Promise<number> {
    const now = this.now();
    const existing = this.counts.get(key);
    if (existing && existing.expiresAt > now) {
      existing.count += amount;
      return existing.count;
    }
    if (this.counts.size >= this.maxKeys) {
      for (const [stale, entry] of this.counts) if (entry.expiresAt <= now) this.counts.delete(stale);
      // Still full of live windows: drop the oldest insertion rather than grow without bound.
      while (this.counts.size >= this.maxKeys) this.counts.delete(this.counts.keys().next().value!);
    }
    this.counts.set(key, { count: amount, expiresAt: now + ttlMs });
    return amount;
  }

  async get(key: string): Promise<number | undefined> {
    const existing = this.counts.get(key);
    return existing && existing.expiresAt > this.now() ? existing.count : undefined;
  }
}

/** Shared store for several instances, over Upstash's REST pipeline (no client library needed). */
export function upstashCounterStore(url: string, token: string, fetchImpl: typeof fetch = fetch): CounterStore {
  const pipeline = async (commands: string[][]): Promise<Array<{ result?: unknown; error?: string }>> => {
    const response = await fetchImpl(`${url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (!response.ok) throw new Error(`Counter store returned HTTP ${response.status}`);
    return (await response.json()) as Array<{ result?: unknown; error?: string }>;
  };
  return {
    async increment(key, ttlMs) {
      const [first] = await pipeline([["INCR", key], ["PEXPIRE", key, String(ttlMs), "NX"]]);
      if (typeof first?.result !== "number") throw new Error("Counter store returned no count");
      return first.result;
    },
    async add(key, amount, ttlMs) {
      const [first] = await pipeline([["INCRBY", key, String(amount)], ["PEXPIRE", key, String(ttlMs), "NX"]]);
      if (typeof first?.result !== "number") throw new Error("Counter store returned no count");
      return first.result;
    },
    async get(key) {
      const response = await fetchImpl(`${url.replace(/\/$/, "")}/get/${encodeURIComponent(key)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Counter store returned HTTP ${response.status}`);
      const body = (await response.json()) as { result?: unknown } | null;
      return typeof body?.result === "number" ? body.result : undefined;
    },
  };
}

/** Raw addresses are never stored; a salted hash is enough to count them. */
export function clientKey(ip: string | undefined, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip ?? "unknown"}`).digest("base64url").slice(0, 22);
}

/**
 * The address identity every free-mode counter is keyed by. A valid install token adds a second,
 * per-installation identity alongside it (see `install-token.ts`); this stays the single place the
 * address half is derived.
 */
export function gatewayIdentity(clientIp: string | undefined, salt: string): string {
  return clientKey(clientIp, salt);
}

/**
 * The store key a rule charges for one identity in one window, or undefined when the rule's scope
 * does not apply (an install rule for a request without a valid token). Keys are plain strings, so
 * every `CounterStore` (in memory or Upstash) supports every scope without changes.
 */
export function counterKey(rule: RateRule, who: string | Identities, window: number): string | undefined {
  const identities: Identities = typeof who === "string" ? { ip: who } : who;
  if (rule.scope === "global") return `free:${rule.name}:all:${window}`;
  const subject = identities[rule.scope];
  return subject === undefined ? undefined : `free:${rule.name}:${rule.scope}:${subject}:${window}`;
}

/**
 * Install rules are charged first, then per-address rules, then global rules, each only if the
 * previous scope passed, so one client hammering past its own limit cannot also drain the shared
 * network or gateway capacity everyone else depends on.
 *
 * A refused request is refunded from every counter it incremented: it never reached the model, so
 * it must not use up allowance. Without this, a client hitting the per-minute burst limit in an
 * agent loop would burn its daily request allowance on requests that were never served. The
 * refund is best effort: if it fails the counts stay high, which errs on the side of limiting.
 */
export async function consume(store: CounterStore, rules: readonly RateRule[], client: string | Identities, now: number): Promise<RateDecision> {
  const counts: RuleCount[] = [];
  const charged: Array<{ key: string; rule: RateRule }> = [];
  for (const scope of ["install", "ip", "global"] as const) {
    let denied: Extract<RateDecision, { ok: false }> | undefined;
    for (const rule of rules.filter((candidate) => candidate.scope === scope)) {
      const key = counterKey(rule, client, Math.floor(now / rule.windowMs));
      if (key === undefined) continue;
      const count = await store.increment(key, rule.windowMs);
      charged.push({ key, rule });
      counts.push({ rule, count });
      const retryAfterMs = rule.windowMs - (now % rule.windowMs);
      if (count > rule.limit && (!denied || retryAfterMs > denied.retryAfterMs)) {
        denied = { ok: false, rule: rule.name, scope, retryAfterMs, limit: rule.limit, windowMs: rule.windowMs, counts };
      }
    }
    if (denied) {
      await Promise.all(charged.map(({ key, rule }) => store.add(key, -1, rule.windowMs).catch(() => undefined)));
      return denied;
    }
  }
  return { ok: true, counts };
}

/**
 * A client's own daily request rules: the non-global rules with the longest window (for the
 * defaults, `ip-day`, or `install-day` and `ip-shared-day`). Global rules are shared capacity,
 * not a client's allowance, so they are not reported as one.
 */
export function dailyRequestRules(rules: readonly RateRule[]): RateRule[] {
  const own = rules.filter((rule) => rule.scope !== "global");
  const longest = Math.max(0, ...own.map((rule) => rule.windowMs));
  return own.filter((rule) => rule.windowMs === longest);
}

/**
 * Requests left in the client's daily allowance before this request was counted (the same
 * convention as the token header), from the counts `consume` returned: the tightest of the
 * client's daily rules that were evaluated. Undefined when none were.
 */
export function remainingRequests(rules: readonly RateRule[], counts: readonly RuleCount[]): number | undefined {
  const daily = new Set(dailyRequestRules(rules));
  let remaining: number | undefined;
  for (const { rule, count } of counts) {
    if (!daily.has(rule)) continue;
    const left = Math.max(0, rule.limit - count + 1);
    remaining = remaining === undefined ? left : Math.min(remaining, left);
  }
  return remaining;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A positive integer from the environment, or the default: nonsense never means zero or unlimited. */
function positive(environment: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = Number(environment[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Documented defaults; each is overridable by the environment variable named beside its use. */
export const DEFAULT_REQUESTS_PER_MINUTE = 20;
export const DEFAULT_REQUESTS_PER_DAY = 300;
export const DEFAULT_TOKENS_PER_DAY = 100_000;

/**
 * Request limits for a client without an install token, keyed by address. Tokens are the real
 * daily budget (see `tokenRulesFrom`); an agent turn sends one request per tool-loop iteration, so
 * the request caps are sized to fit agent loops and only stop runaway or scripted clients:
 * twenty a minute (a fast tool loop, not a hammer) and three hundred a day. Global rules stay sized to OpenRouter's
 * documented free-model allowance for a funded account; operators should set them from their own
 * account's limits.
 */
export function rulesFrom(environment: Record<string, string | undefined>): RateRule[] {
  return [
    { name: "ip-minute", scope: "ip", windowMs: MINUTE, limit: positive(environment, "FREE_GATEWAY_IP_PER_MINUTE", DEFAULT_REQUESTS_PER_MINUTE) },
    { name: "ip-day", scope: "ip", windowMs: DAY, limit: positive(environment, "FREE_GATEWAY_IP_PER_DAY", DEFAULT_REQUESTS_PER_DAY) },
    ...globalRulesFrom(environment),
  ];
}

function globalRulesFrom(environment: Record<string, string | undefined>): RateRule[] {
  return [
    { name: "global-minute", scope: "global", windowMs: MINUTE, limit: positive(environment, "FREE_GATEWAY_GLOBAL_PER_MINUTE", 20) },
    { name: "global-day", scope: "global", windowMs: DAY, limit: positive(environment, "FREE_GATEWAY_GLOBAL_PER_DAY", 1_000) },
  ];
}

/**
 * Request limits for a client with a valid install token. The installation gets the allowance an
 * anonymous address gets; the address it shares with others (a NAT, a campus) gets a much larger
 * ceiling, so many installs behind one IP can each use theirs while one IP still cannot take
 * everything. Global rules are the same counters anonymous requests charge.
 */
export function installRulesFrom(environment: Record<string, string | undefined>): RateRule[] {
  return [
    { name: "install-minute", scope: "install", windowMs: MINUTE, limit: positive(environment, "FREE_GATEWAY_INSTALL_PER_MINUTE", DEFAULT_REQUESTS_PER_MINUTE) },
    { name: "install-day", scope: "install", windowMs: DAY, limit: positive(environment, "FREE_GATEWAY_INSTALL_PER_DAY", DEFAULT_REQUESTS_PER_DAY) },
    { name: "ip-shared-minute", scope: "ip", windowMs: MINUTE, limit: positive(environment, "FREE_GATEWAY_IP_PER_MINUTE_WITH_INSTALL", 120) },
    { name: "ip-shared-day", scope: "ip", windowMs: DAY, limit: positive(environment, "FREE_GATEWAY_IP_PER_DAY_WITH_INSTALL", 3_000) },
    ...globalRulesFrom(environment),
  ];
}

/**
 * Token rules. Unlike request rules these are not charged up front (a request's
 * token usage is only known once the model has answered), so the count before a
 * request is sent is the gate, and measured usage is charged afterwards. One
 * hundred thousand tokens a day is a few real agent tasks on the small context
 * windows free models have.
 */
export function tokenRulesFrom(environment: Record<string, string | undefined>): RateRule[] {
  return [{ name: "ip-token-day", scope: "ip", windowMs: DAY, limit: positive(environment, "FREE_GATEWAY_IP_TOKENS_PER_DAY", DEFAULT_TOKENS_PER_DAY) }];
}

/** Token rules for a client with a valid install token: its own daily allowance, plus a shared-address ceiling. */
export function installTokenRulesFrom(environment: Record<string, string | undefined>): RateRule[] {
  return [
    { name: "install-token-day", scope: "install", windowMs: DAY, limit: positive(environment, "FREE_GATEWAY_INSTALL_TOKENS_PER_DAY", DEFAULT_TOKENS_PER_DAY) },
    { name: "ip-shared-token-day", scope: "ip", windowMs: DAY, limit: positive(environment, "FREE_GATEWAY_IP_TOKENS_PER_DAY_WITH_INSTALL", 2_000_000) },
  ];
}

/**
 * Limits on issuing install tokens. Without them a client could mint a fresh install per request
 * and turn the per-install allowance into an unlimited one; five a day per address covers a lab
 * of reinstalls, and the shared-address ceiling above bounds what those installs can spend.
 */
export function issueRulesFrom(environment: Record<string, string | undefined>): RateRule[] {
  return [
    { name: "issue-ip-day", scope: "ip", windowMs: DAY, limit: positive(environment, "FREE_GATEWAY_INSTALLS_PER_IP_PER_DAY", 5) },
    { name: "issue-global-day", scope: "global", windowMs: DAY, limit: positive(environment, "FREE_GATEWAY_INSTALLS_GLOBAL_PER_DAY", 5_000) },
  ];
}
