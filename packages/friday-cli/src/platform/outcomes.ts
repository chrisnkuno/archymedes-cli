import { randomUUID } from "node:crypto";
import type { RoutingReceipt } from "@archymedes/core/providers/routing-receipt";
import { PROVIDER_IDS } from "@archymedes/core/providers/provider-specs";

/**
 * The outcome event a finished task becomes, when — and only when — the person turned outcome
 * reporting on (`friday outcomes on`; see outcome-reporting.ts for consent, queue and delivery).
 *
 * The contract is `archymedes.outcome/v1`, shared with the receiving service; names here are the
 * wire names and must not drift. The builder is deliberately an allow-list: it reads a fixed set of
 * enum and numeric facts about the task and nothing else, so a prompt, an answer, a path, a repo or
 * file name, or an error message cannot reach the wire even when a caller hands it the whole result.
 * Every string feature is squeezed through `FEATURE_STRING`, and free-form ids that could carry text
 * (a model name a person typed) collapse to `custom` the moment they look like prose or a path.
 */

export const OUTCOME_SCHEMA = "archymedes.outcome/v1";
/** Every string feature value, and every label, must match this. */
export const FEATURE_STRING = /^[a-z0-9_.:-]{1,64}$/;
export const MAX_FEATURES = 64;

export type FeatureValue = number | boolean | string;

export type OutcomeEvent = {
  schema: typeof OUTCOME_SCHEMA;
  id: string;
  product: "friday";
  kind: "task";
  occurredAt: string;
  installId: string;
  appVersion: string;
  consent: { scope: "outcomes"; grantedAt: string };
  features: Record<string, FeatureValue>;
  prediction?: { label: string; p?: number };
  outcome: { label: string; value?: number };
};

export type OutcomeBatch = { events: OutcomeEvent[] };

/**
 * What a task end may report. Callers pass whatever they have; only these fields are ever read, and
 * each is normalised to an enum, a bucket or a bounded count.
 */
export type TaskOutcomeInput = {
  engine?: string;
  provider?: string;
  model?: string;
  effort?: string;
  status: string;
  toolCalls?: number;
  iterations?: number;
  repairs?: number;
  elapsedMs?: number;
  actualModelRwf?: number;
  routingReceipts?: readonly RoutingReceipt[];
};

/** Every key `taskFeatures` can produce, in wire order. */
export const OUTCOME_FEATURE_KEYS = [
  "engine", "route", "provider", "model", "effort", "tool_calls", "repairs", "turns",
  "duration_bucket", "cost_bucket_rwf", "reliability_bucket", "exit_status",
] as const;

const ENGINES = ["archymedes", "claude", "codex", "terminal"] as const;
const EFFORTS = ["auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const STATUSES = ["completed", "failed", "blocked", "needs_approval", "needs_verification", "cancelled", "iteration_limit"] as const;
const PROVIDERS: readonly string[] = [...PROVIDER_IDS, "free", "claude", "codex"];

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T;
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined;
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback?: T): T | undefined {
  const normal = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(normal) ? normal as T : fallback;
}

/** A non-negative whole count, capped so an outlier cannot fingerprint a session. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(10_000, Math.floor(value)) : 0;
}

/**
 * A model id in the feature alphabet, or `custom`.
 *
 * Model ids are the one feature a person can type freely (a local model, a custom endpoint), so
 * anything shaped like a path or a sentence — whitespace, a backslash, a leading `/ ~ .`, more than
 * one `/`, or a file extension — is not an id and is never sent.
 */
export function normaliseModelId(raw: string | undefined): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 96) return "custom";
  if (/[\s\\]/.test(value) || /^[/~.]/.test(value) || (value.match(/\//g)?.length ?? 0) > 1) return "custom";
  if (/\.(gguf|bin|safetensors|pt|pth|onnx|ts|tsx|js|py|go|rs|json|ya?ml|md|txt|env)$/i.test(value)) return "custom";
  const normal = value.toLowerCase().replace(/\//g, ":").replace(/[^a-z0-9_.:-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return FEATURE_STRING.test(normal) ? normal : "custom";
}

export function durationBucket(elapsedMs: number): string {
  const ms = typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  if (ms < 10_000) return "lt_10s";
  if (ms < 60_000) return "lt_1m";
  if (ms < 300_000) return "lt_5m";
  if (ms < 1_800_000) return "lt_30m";
  return "gte_30m";
}

/** Spend in Rwandan francs (the runtime's integer unit), bucketed by order of magnitude. */
export function costBucket(rwf: number): string {
  const value = typeof rwf === "number" && Number.isFinite(rwf) && rwf > 0 ? rwf : 0;
  if (value === 0) return "0";
  if (value < 10) return "lt_10";
  if (value < 100) return "lt_100";
  if (value < 1_000) return "lt_1k";
  if (value < 10_000) return "lt_10k";
  return "gte_10k";
}

function unitScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
}

/** The task's features: enums, buckets and counts only. */
export function taskFeatures(input: TaskOutcomeInput): Record<string, FeatureValue> {
  const receipts = Array.isArray(input.routingReceipts) ? input.routingReceipts : [];
  const last = receipts.at(-1);
  const reliability = unitScore(last?.outcomeScore);
  const effort = oneOf(input.effort, EFFORTS);
  const routedRetries = receipts.reduce((sum, receipt) => sum + count(receipt?.retries), 0);
  const features: Record<string, FeatureValue> = {
    engine: oneOf(input.engine, [...ENGINES, "other"], "other"),
    route: receipts.length > 0 ? "exchange" : "direct",
    ...(input.provider !== undefined ? { provider: oneOf(input.provider, PROVIDERS, "custom") } : {}),
    ...(input.model !== undefined ? { model: normaliseModelId(input.model) } : {}),
    ...(effort ? { effort } : {}),
    tool_calls: count(input.toolCalls),
    repairs: input.repairs !== undefined ? count(input.repairs) : Math.min(10_000, routedRetries),
    turns: count(input.iterations),
    ...(input.elapsedMs !== undefined ? { duration_bucket: durationBucket(input.elapsedMs) } : {}),
    ...(input.actualModelRwf !== undefined ? { cost_bucket_rwf: costBucket(input.actualModelRwf) } : {}),
    ...(reliability !== undefined ? { reliability_bucket: Math.floor(reliability * 10) / 10 } : {}),
    exit_status: oneOf(input.status, [...STATUSES, "other"], "other"),
  };
  return features;
}

/** What the session knows about where the task ran, alongside its runtime result. */
export type TaskMeta = { engine: string; provider?: string; model?: string; effort?: string; elapsedMs?: number };

/**
 * A finished task's outcome input, from whatever the engine returned. Only status, counts, spend and
 * routing receipts are read; the summary, messages and anything else stay behind.
 */
export function taskOutcomeInput(
  result: { readonly status: string } & { readonly [field: string]: unknown },
  meta: TaskMeta,
): TaskOutcomeInput {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const toolCalls = number(result.toolCallsExecuted);
  const iterations = number(result.iterations);
  const actualModelRwf = number(result.actualModelRwf);
  return {
    engine: meta.engine,
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
    status: result.status,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(actualModelRwf !== undefined ? { actualModelRwf } : {}),
    ...(Array.isArray(result.routingReceipts) ? { routingReceipts: result.routingReceipts as RoutingReceipt[] } : {}),
    ...(meta.elapsedMs !== undefined ? { elapsedMs: meta.elapsedMs } : {}),
  };
}

export type OutcomeContext = { installId: string; grantedAt: string; appVersion: string; now: number; id?: string };

export function buildOutcomeEvent(input: TaskOutcomeInput, context: OutcomeContext): OutcomeEvent {
  const features = taskFeatures(input);
  const status = features.exit_status as string;
  const predicted = unitScore(input.routingReceipts?.at(-1)?.predictedOutcomeScore);
  return {
    schema: OUTCOME_SCHEMA,
    id: context.id ?? randomUUID(),
    product: "friday",
    kind: "task",
    occurredAt: new Date(context.now).toISOString(),
    installId: context.installId,
    appVersion: context.appVersion,
    consent: { scope: "outcomes", grantedAt: context.grantedAt },
    features,
    ...(predicted !== undefined ? { prediction: { label: "completed", p: predicted } } : {}),
    outcome: { label: status, value: status === "completed" ? 1 : 0 },
  };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Contract violations, empty when the event is valid. Checked again before anything is queued. */
export function validateOutcomeEvent(event: OutcomeEvent): string[] {
  const errors: string[] = [];
  if (event.schema !== OUTCOME_SCHEMA) errors.push("schema");
  if (!UUID_V4.test(event.id)) errors.push("id");
  if (event.product !== "friday" || event.kind !== "task") errors.push("product/kind");
  if (!ISO_UTC.test(event.occurredAt)) errors.push("occurredAt");
  if (!UUID_V4.test(event.installId)) errors.push("installId");
  if (typeof event.appVersion !== "string" || !event.appVersion || event.appVersion.length > 64) errors.push("appVersion");
  if (event.consent?.scope !== "outcomes" || !ISO_UTC.test(event.consent.grantedAt ?? "")) errors.push("consent");
  const entries = Object.entries(event.features ?? {});
  if (entries.length > MAX_FEATURES) errors.push("features: too many keys");
  for (const [key, value] of entries) {
    if (!FEATURE_STRING.test(key)) errors.push(`features.${key}: key`);
    if (typeof value === "string" ? !FEATURE_STRING.test(value) : typeof value === "number" ? !Number.isFinite(value) : typeof value !== "boolean") errors.push(`features.${key}: value`);
  }
  if (event.prediction && (!FEATURE_STRING.test(event.prediction.label) || (event.prediction.p !== undefined && unitScore(event.prediction.p) !== event.prediction.p))) errors.push("prediction");
  if (!event.outcome || !FEATURE_STRING.test(event.outcome.label) || (event.outcome.value !== undefined && !Number.isFinite(event.outcome.value))) errors.push("outcome");
  return errors;
}
