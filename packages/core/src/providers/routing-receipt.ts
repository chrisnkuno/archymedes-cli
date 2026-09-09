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
export const TASK_KINDS = [
  "coding", "design", "architecture", "security", "research", "deployment",
  "general", "code", "reasoning", "vision", "agentic", "extraction", "summarization",
  "translation", "classification", "creative",
] as const;
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
  /** Ranking utility; its scale is defined by the routing policy. */
  score?: number;
};

export type RoutingReceipt = {
  taskId?: string;
  policyId?: string;
  policyVersion?: number;
  attempts?: Array<{ provider?: string; model: string; outcome: string; latencyMs?: number }>;
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
  /** Expected whole-task spend, distinct from the single-call estimate and settled charge. */
  expectedTotalMicros?: number;
  /** A prediction, never presented as measured evaluation evidence. */
  predictedOutcomeScore?: number;
  costFactors?: { retryMicros?: number; contextTransferMicros?: number; cacheSavingMicros?: number; verificationMicros?: number; nonModelMicros?: number };
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
    ...(finiteNumber(value.score) !== undefined ? { score: finiteNumber(value.score) } : {}),
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
  const chosenModel = trimmedString(chosenRaw.model) ?? trimmedString(value.chosen_model) ?? trimmedString(value.selectedModel);
  if (!chosenModel) return null;

  const consideredRaw = Array.isArray(value.considered)
    ? value.considered
    : Array.isArray((value as Record<string, unknown>).routes)
      ? (value as Record<string, unknown>).routes as unknown[]
      : [];
  const considered = consideredRaw
    .map(parseConsideredRoute)
    .filter((route): route is ConsideredRoute => route !== null);

  const attempts = Array.isArray(value.attempts) ? value.attempts.flatMap((attempt) => {
    if (!isRecord(attempt) || !trimmedString(attempt.model) || !trimmedString(attempt.outcome)) return [];
    const started = typeof attempt.startedAt === "string" ? Date.parse(attempt.startedAt) : NaN;
    const completed = typeof attempt.completedAt === "string" ? Date.parse(attempt.completedAt) : NaN;
    const latencyMs = nonNegativeInt(attempt.latencyMs ?? (completed - started));
    return [{ model: trimmedString(attempt.model)!, outcome: trimmedString(attempt.outcome)!,
      ...(trimmedString(attempt.provider) ? { provider: trimmedString(attempt.provider) } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    }];
  }) : undefined;
  const latencyMs = nonNegativeInt(value.latencyMs ?? value.latency_ms ?? value.totalLatencyMs ?? (attempts?.length && attempts.every((attempt) => attempt.latencyMs !== undefined) ? attempts.reduce((sum, attempt) => sum + attempt.latencyMs!, 0) : undefined));
  const estimated = isRecord(value.estimated) ? value.estimated : {};
  const actual = isRecord(value.actual) ? value.actual : {};
  // Never label settlement in a different currency as the estimate's currency.
  const currency = trimmedString(value.currency ?? estimated.currency ?? actual.currency)?.toUpperCase();
  const actualMicros = actual.currency && trimmedString(actual.currency)?.toUpperCase() !== currency
    ? undefined : nonNegativeInt(value.actualMicros ?? value.actual_micros ?? actual.micros);
  const factorsRaw = isRecord(value.costFactors) ? value.costFactors : isRecord(value.factors) ? value.factors : {};
  const costFactors: NonNullable<RoutingReceipt["costFactors"]> = {};
  for (const [camel, snake] of [["retryMicros", "retry_micros"], ["contextTransferMicros", "context_transfer_micros"], ["cacheSavingMicros", "cache_saving_micros"], ["verificationMicros", "verification_micros"], ["nonModelMicros", "non_model_micros"]] as const) {
    const amount = nonNegativeInt(factorsRaw[camel] ?? factorsRaw[snake]);
    if (amount !== undefined) costFactors[camel] = amount;
  }
  const policyRaw = isRecord(value.policy) ? value.policy : {};
  const policy: RoutingReceipt["policy"] = {};
  if (trimmedString(policyRaw.dataPolicy ?? policyRaw.data_policy)) policy.dataPolicy = trimmedString(policyRaw.dataPolicy ?? policyRaw.data_policy);
  if (trimmedString(policyRaw.region)) policy.region = trimmedString(policyRaw.region);
  if (score(policyRaw.qualityFloor ?? policyRaw.quality_floor) !== undefined) policy.qualityFloor = score(policyRaw.qualityFloor ?? policyRaw.quality_floor);
  if (nonNegativeInt(policyRaw.maximumMicros ?? policyRaw.maximum_micros) !== undefined) policy.maximumMicros = nonNegativeInt(policyRaw.maximumMicros ?? policyRaw.maximum_micros);

  return {
    ...(trimmedString(value.taskId ?? value.task_id ?? value.requestId) ? { taskId: trimmedString(value.taskId ?? value.task_id ?? value.requestId) } : {}),
    ...(trimmedString(value.policyId) ? { policyId: trimmedString(value.policyId) } : {}),
    ...(nonNegativeInt(value.policyVersion) !== undefined ? { policyVersion: nonNegativeInt(value.policyVersion) } : {}),
    ...(attempts ? { attempts } : {}),
    chosen: {
      model: chosenModel,
      ...(trimmedString(chosenRaw.provider ?? value.selectedProvider) ? { provider: trimmedString(chosenRaw.provider ?? value.selectedProvider) } : {}),
    },
    considered,
    policy,
    ...(currency ? { currency } : {}),
    ...(nonNegativeInt(value.estimatedMicros ?? value.estimated_micros ?? estimated.micros) !== undefined
      ? { estimatedMicros: nonNegativeInt(value.estimatedMicros ?? value.estimated_micros ?? estimated.micros) }
      : {}),
    ...(nonNegativeInt(value.expectedTotalMicros ?? value.expected_total_micros) !== undefined
      ? { expectedTotalMicros: nonNegativeInt(value.expectedTotalMicros ?? value.expected_total_micros) } : {}),
    ...(score(value.predictedOutcomeScore ?? value.predicted_outcome_score) !== undefined
      ? { predictedOutcomeScore: score(value.predictedOutcomeScore ?? value.predicted_outcome_score) } : {}),
    ...(Object.keys(costFactors).length ? { costFactors } : {}),
    ...(nonNegativeInt(actualMicros) !== undefined
      ? { actualMicros }
      : {}),
    retries: nonNegativeInt(value.retries) ?? Math.max(0, (attempts?.length ?? 0) - 1),
    ...(latencyMs !== undefined
      ? { latencyMs }
      : {}),
    ...(score(value.outcomeScore ?? value.outcome_score ?? value.finalOutcomeScore) !== undefined
      ? { outcomeScore: score(value.outcomeScore ?? value.outcome_score ?? value.finalOutcomeScore) }
      : {}),
  };
}

/** Normalize stored receipts and replace replayed calls without counting a settlement twice.
 * Unidentified legacy calls remain distinct: equal prices/models do not establish identity.
 */
export function mergeRoutingReceipts(...batches: unknown[]): RoutingReceipt[] {
  const receipts: RoutingReceipt[] = [];
  const positions = new Map<string, number>();
  for (const batch of batches) {
    if (!Array.isArray(batch)) continue;
    for (const value of batch) {
      const receipt = parseRoutingReceipt(value);
      if (!receipt) continue;
      const index = receipt.taskId ? positions.get(receipt.taskId) : undefined;
      if (index === undefined) {
        if (receipt.taskId) positions.set(receipt.taskId, receipts.length);
        receipts.push(receipt);
      } else {
        const previous = receipts[index];
        // Never carry a charge into a different currency when a newer record changes units.
        receipts[index] = previous.currency === receipt.currency
          ? { ...previous, ...receipt } : receipt;
      }
    }
  }
  return receipts;
}
