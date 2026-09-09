/**
 * The client's view of a hosted routing *preflight*.
 *
 * A receipt says what the exchange did and what it charged. A plan says what it would do, before
 * any money is committed: which routes are eligible under the current policy, what each would be
 * expected to cost for the whole task, and which are not available at all. Planning calls no model,
 * reserves no credit and settles nothing — it is a read against the routing policy.
 *
 * Two things follow from that, and both are enforced here rather than left to the renderer:
 *
 *  - A plan carries *forecasts*. Every number below is an estimate the exchange stands behind only
 *    as an estimate, and none of them may be presented the way a settled charge is.
 *  - An empty plan is not a selection. When no route is available the exchange returns an empty
 *    ranking with the reasons in `excluded`; a client that renders that as "nothing to report" tells
 *    the user capacity exists when it does not.
 *
 * As with `routing-receipt.ts`, the exchange is a network peer: anything that is not a plan parses
 * to `null` rather than throwing, and individual malformed routes are dropped, not fatal.
 */

/** One route the exchange weighed during a preflight. */
export type PlannedRoute = {
  provider?: string;
  model: string;
  /** False when a policy constraint, a budget or a missing credential ruled it out. */
  eligible: boolean;
  /** Why it ranks where it does, or why it cannot be used. */
  reason: string;
  /** Ranking utility on the policy's own scale — not a probability. */
  score?: number;
  /** Forecast charge for one call on this route. */
  estimatedMicros?: number;
  /** Forecast charge for the whole task, including expected retries and context movement. */
  expectedTotalMicros?: number;
  expectedAttempts?: number;
  expectedLatencyMs?: number;
  /** Predicted quality of the completed task, 0..1. A forecast, never an evaluation. */
  completedQuality?: number;
  /** Predicted quality per currency unit — the exchange's own ranking objective. */
  outcomePerDollar?: number;
  /** "byok" means the call is paid to the provider with the user's own key, not from credits. */
  fundingSource?: "platform" | "byok";
};

export type RoutingPlan = {
  policyId?: string;
  policyVersion?: number;
  currency: string;
  /** Ranked best-first. Empty means no route is usable, never "no opinion". */
  ranked: PlannedRoute[];
  /** Routes removed before ranking — a missing credential, a disabled provider. */
  excluded: PlannedRoute[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? Math.round(number) : undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function money(value: unknown): { currency?: string; micros?: number } {
  if (!isRecord(value)) return {};
  return { currency: trimmedString(value.currency), micros: nonNegativeInt(value.micros) };
}

/**
 * Reads one entry of `ranked` or `excluded`.
 *
 * The two lists have different shapes on the wire — a ranked route nests its candidate and carries
 * forecasts, an excluded one is flat and carries only a reason — so both are accepted here and
 * normalized to the same type. A route without a model is not a route.
 */
function parsePlannedRoute(value: unknown): PlannedRoute | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.candidate) ? value.candidate : value;
  const model = trimmedString(candidate.model);
  if (!model) return null;
  const charged = money(value.estimated_charged ?? value.estimatedCharged);
  const funding = trimmedString(value.funding_source ?? value.fundingSource);
  return {
    model,
    ...(trimmedString(candidate.provider) ? { provider: trimmedString(candidate.provider) } : {}),
    eligible: value.eligible !== false,
    reason: trimmedString(value.reason) ?? "",
    ...(finiteNumber(value.score) !== undefined ? { score: finiteNumber(value.score) } : {}),
    ...(charged.micros !== undefined ? { estimatedMicros: charged.micros } : {}),
    ...(nonNegativeInt(value.expected_total_micros ?? value.expectedTotalMicros) !== undefined
      ? { expectedTotalMicros: nonNegativeInt(value.expected_total_micros ?? value.expectedTotalMicros) } : {}),
    ...(finiteNumber(value.expected_attempts ?? value.expectedAttempts) !== undefined
      ? { expectedAttempts: finiteNumber(value.expected_attempts ?? value.expectedAttempts) } : {}),
    ...(nonNegativeInt(value.expected_latency_ms ?? value.expectedLatencyMs) !== undefined
      ? { expectedLatencyMs: nonNegativeInt(value.expected_latency_ms ?? value.expectedLatencyMs) } : {}),
    ...(finiteNumber(value.completed_quality ?? value.completedQuality) !== undefined
      ? { completedQuality: Math.max(0, Math.min(1, finiteNumber(value.completed_quality ?? value.completedQuality)!)) } : {}),
    ...(finiteNumber(value.outcome_per_dollar ?? value.outcomePerDollar) !== undefined
      ? { outcomePerDollar: finiteNumber(value.outcome_per_dollar ?? value.outcomePerDollar) } : {}),
    ...(funding === "byok" || funding === "platform" ? { fundingSource: funding } : {}),
  };
}

/**
 * Reads an exchange routing plan, or returns null for anything that is not one.
 *
 * A response with both lists empty still parses: "no capacity, and here is nothing to explain it"
 * is a real answer the user needs to see, and it is not the same as a malformed response.
 */
export function parseRoutingPlan(value: unknown): RoutingPlan | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.ranked) && !Array.isArray(value.excluded)) return null;
  const policy = isRecord(value.policy) ? value.policy : {};
  const ranked = (Array.isArray(value.ranked) ? value.ranked : []).map(parsePlannedRoute).filter((route): route is PlannedRoute => route !== null);
  const excluded = (Array.isArray(value.excluded) ? value.excluded : []).map(parsePlannedRoute).filter((route): route is PlannedRoute => route !== null)
    // Whatever the service says, a route it removed before ranking is not eligible.
    .map((route) => ({ ...route, eligible: false }));
  return {
    ...(trimmedString(policy.id) ? { policyId: trimmedString(policy.id) } : {}),
    ...(finiteNumber(policy.version) !== undefined ? { policyVersion: finiteNumber(policy.version) } : {}),
    currency: planCurrency(value.ranked) ?? "USD",
    ranked,
    excluded,
  };
}

/** The currency the forecasts are quoted in, taken from the first route that states one. */
function planCurrency(ranked: unknown): string | undefined {
  if (!Array.isArray(ranked)) return undefined;
  for (const route of ranked) {
    if (!isRecord(route)) continue;
    const currency = money(route.estimated_charged ?? route.estimatedCharged).currency;
    if (currency) return currency;
  }
  return undefined;
}
