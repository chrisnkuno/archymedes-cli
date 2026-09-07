/**
 * The client's view of a hosted routing decision.
 *
 * The exchange chooses which model runs a unit of work and returns a receipt saying what it picked,
 * what else it weighed, the policy it was held to, and what the work cost against the estimate. The
 * routing intelligence itself is a private service; this is only the shape the CLI reads back and
 * the profile it sends, both defined by `docs/EXCHANGE_API.md`. Nothing here makes a routing
 * decision — it parses one and prepares the request that asks for one.
 *
 * The receipt never carries the raw prompt (`EXCHANGE_API.md`), and this parser is deliberately
 * defensive: the exchange is a network peer, so a malformed or partial receipt yields `null`
 * rather than a throw, and a turn with no receipt is a normal turn.
 */

/** Every task-kind the profile may declare — matches the exchange's `profile.kind` vocabulary. */
export const TASK_KINDS = ["coding", "design", "architecture", "security", "research", "deployment"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export type TaskProfileInput = {
  kind: TaskKind;
  /** Capabilities the route must have: "tools", "vision", "long-context", "structured-output", "reasoning". */
  requiredCapabilities?: readonly string[];
  /** "standard" | "no-training" | "zero-retention" | "local-only". */
  dataPolicy?: string;
  /** Preferred data-residency region, e.g. "us", "eu". */
  region?: string;
  /** Lowest acceptable predicted outcome quality, 0..1. */
  qualityFloor?: number;
};

/** The `archymedes.profile` object sent with a hosted completion. Empty fields are omitted. */
export function buildTaskProfile(input: TaskProfileInput): Record<string, unknown> {
  const profile: Record<string, unknown> = { kind: input.kind };
  const capabilities = (input.requiredCapabilities ?? []).filter((capability) => capability.trim().length > 0);
  if (capabilities.length > 0) profile.requiredCapabilities = capabilities;
  if (input.dataPolicy && input.dataPolicy !== "standard") profile.dataPolicy = input.dataPolicy;
  if (input.region?.trim()) profile.region = input.region.trim();
  if (typeof input.qualityFloor === "number" && input.qualityFloor > 0) {
    profile.qualityFloor = clamp01(input.qualityFloor);
  }
  return profile;
}

/** One route the exchange weighed, whether or not it was chosen. */
export type ConsideredRoute = {
  model: string;
  provider?: string;
  /** False when a policy constraint or a limit ruled it out before scoring. */
  eligible: boolean;
  /** Why it was chosen, or why it was passed over. */
  reason: string;
  estimatedMicros?: number;
  /** Predicted outcome quality for this route, 0..1. */
  score?: number;
};

export type RoutingReceipt = {
  taskId?: string;
  chosen: { model: string; provider?: string };
  considered: ConsideredRoute[];
  policy: {
    dataPolicy?: string;
    region?: string;
    qualityFloor?: number;
    maximumMicros?: number;
  };
  currency?: string;
  estimatedMicros?: number;
  actualMicros?: number;
  /** Provider attempts beyond the first, from the exchange's bounded retry. */
  retries: number;
  latencyMs?: number;
  /** Archymedes' evaluation of the completed outcome, 0..1, when one was scored. */
  outcomeScore?: number;
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function score(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : clamp01(number);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseConsideredRoute(value: unknown): ConsideredRoute | null {
  if (!isRecord(value)) return null;
  const model = trimmedString(value.model);
  if (!model) return null;
  return {
    model,
    ...(trimmedString(value.provider) ? { provider: trimmedString(value.provider) } : {}),
    eligible: value.eligible !== false,
    reason: trimmedString(value.reason) ?? "",
    ...(nonNegativeInt(value.estimatedMicros ?? value.estimated_micros) !== undefined
      ? { estimatedMicros: nonNegativeInt(value.estimatedMicros ?? value.estimated_micros) }
      : {}),
    ...(score(value.score) !== undefined ? { score: score(value.score) } : {}),
  };
}

/**
 * Reads an exchange routing receipt, or returns null for anything that is not one.
 *
 * Accepts both camelCase and the snake_case the wire also uses for a few fields, and tolerates a
 * missing `considered` list or `policy` block — a thin receipt is still worth showing.
 */
export function parseRoutingReceipt(value: unknown): RoutingReceipt | null {
  if (!isRecord(value)) return null;
  const chosenRaw = isRecord(value.chosen) ? value.chosen : value;
  const chosenModel = trimmedString(chosenRaw.model) ?? trimmedString((value as Record<string, unknown>).chosen_model);
  if (!chosenModel) return null;

  const consideredRaw = Array.isArray(value.considered)
    ? value.considered
    : Array.isArray((value as Record<string, unknown>).routes)
      ? (value as Record<string, unknown>).routes as unknown[]
      : [];
  const considered = consideredRaw
    .map(parseConsideredRoute)
    .filter((route): route is ConsideredRoute => route !== null);

  const policyRaw = isRecord(value.policy) ? value.policy : {};
  const policy: RoutingReceipt["policy"] = {};
  if (trimmedString(policyRaw.dataPolicy ?? policyRaw.data_policy)) policy.dataPolicy = trimmedString(policyRaw.dataPolicy ?? policyRaw.data_policy);
  if (trimmedString(policyRaw.region)) policy.region = trimmedString(policyRaw.region);
  if (score(policyRaw.qualityFloor ?? policyRaw.quality_floor) !== undefined) policy.qualityFloor = score(policyRaw.qualityFloor ?? policyRaw.quality_floor);
  if (nonNegativeInt(policyRaw.maximumMicros ?? policyRaw.maximum_micros) !== undefined) policy.maximumMicros = nonNegativeInt(policyRaw.maximumMicros ?? policyRaw.maximum_micros);

  return {
    ...(trimmedString(value.taskId ?? value.task_id) ? { taskId: trimmedString(value.taskId ?? value.task_id) } : {}),
    chosen: {
      model: chosenModel,
      ...(trimmedString(chosenRaw.provider) ? { provider: trimmedString(chosenRaw.provider) } : {}),
    },
    considered,
    policy,
    ...(trimmedString(value.currency) ? { currency: trimmedString(value.currency)!.toUpperCase() } : {}),
    ...(nonNegativeInt(value.estimatedMicros ?? value.estimated_micros) !== undefined
      ? { estimatedMicros: nonNegativeInt(value.estimatedMicros ?? value.estimated_micros) }
      : {}),
    ...(nonNegativeInt(value.actualMicros ?? value.actual_micros) !== undefined
      ? { actualMicros: nonNegativeInt(value.actualMicros ?? value.actual_micros) }
      : {}),
    retries: nonNegativeInt(value.retries) ?? 0,
    ...(nonNegativeInt(value.latencyMs ?? value.latency_ms) !== undefined
      ? { latencyMs: nonNegativeInt(value.latencyMs ?? value.latency_ms) }
      : {}),
    ...(score(value.outcomeScore ?? value.outcome_score) !== undefined
      ? { outcomeScore: score(value.outcomeScore ?? value.outcome_score) }
      : {}),
  };
}
