// Vendored verbatim from @archymedes/protocol `src/outcomes.ts` (Apache-2.0), the receiving
// service's validator for archymedes.outcome/v1. Friday checks every event with it before queueing,
// so a client-built event the server would refuse never leaves the machine. Do not edit below the
// marker: update by re-copying; `outcome-protocol.test.ts` fails on drift when the source is present.
// --- vendored verbatim below ---
/**
 * archymedes.outcome/v1 — opt-in, privacy-minimal outcome events.
 *
 * This module is deliberately dependency-free (no zod, no node built-ins) so public clients
 * (React Native, browsers, Bun, Workers) can vendor it verbatim. Every string a client may send is
 * either a fixed literal, a UUID v4, an ISO-8601 UTC timestamp, a version token, or an *enum*
 * matching OUTCOME_ENUM_PATTERN. Free text has no slot in the schema. See docs/OUTCOMES.md.
 */

export const OUTCOME_SCHEMA = "archymedes.outcome/v1" as const;
/** Lower-case enum token. No spaces, '@', '/', '\\', uppercase, or non-ASCII. */
export const OUTCOME_ENUM_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
export const OUTCOME_MAX_BATCH_EVENTS = 100;
export const OUTCOME_MAX_BATCH_BYTES = 64 * 1024;
export const OUTCOME_MAX_FEATURE_KEYS = 64;
/** Events dated more than this far past `now` are rejected when `now` is supplied. */
export const OUTCOME_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export const OUTCOME_PRODUCT_KINDS = { friday: "task", orion: "decision", argus: "finding" } as const;
export type OutcomeProduct = keyof typeof OUTCOME_PRODUCT_KINDS;
export type OutcomeKind = (typeof OUTCOME_PRODUCT_KINDS)[OutcomeProduct];

export type OutcomeFeatureValue = number | boolean | string;

export type OutcomeEvent = {
  schema: typeof OUTCOME_SCHEMA;
  /** UUID v4, client-generated; the idempotency key. */
  id: string;
  product: OutcomeProduct;
  kind: OutcomeKind;
  /** ISO-8601 UTC ("Z"). */
  occurredAt: string;
  /** Random per-install UUID v4, rotatable. Never a user or account id. */
  installId: string;
  appVersion: string;
  consent: { scope: "outcomes"; grantedAt: string };
  /** Enum-only descriptors; string values and keys match OUTCOME_ENUM_PATTERN; at most 64 keys. */
  features: Record<string, OutcomeFeatureValue>;
  prediction?: { label: string; p?: number };
  outcome: { label: string; value?: number };
};

export type OutcomeBatch = { events: OutcomeEvent[] };

export type OutcomeValidationOptions = {
  /** When supplied, events dated more than OUTCOME_MAX_FUTURE_SKEW_MS after `now` are rejected. */
  now?: Date;
};

export type OutcomeBatchValidationOptions = OutcomeValidationOptions & {
  /** Byte length of the raw request body, if known. Otherwise UTF-8 JSON length is computed. */
  byteLength?: number;
};

export type OutcomeEventValidation = { ok: true; value: OutcomeEvent } | { ok: false; errors: string[] };

export type OutcomeBatchValidation = {
  /** True only when the batch envelope is valid and every event is valid. */
  ok: boolean;
  /** Batch-level errors. When non-empty, no event is accepted. */
  errors: string[];
  valid: OutcomeEvent[];
  /** `id` is echoed only when it is a well-formed UUID, never arbitrary client text. */
  invalid: Array<{ index: number; id?: string; reason: string }>;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
// Identifier-shaped tokens that fit the enum alphabet but are not enums: phone/account numbers,
// UUIDs, long hex tokens, and host names.
const DIGIT_RUN = /\d{7,}/;
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const HEX_RUN = /[0-9a-f]{16,}/g;
const HOST_LIKE = /(^|[._:-])www\.|\.(com|org|net|edu|gov|io|dev|app|ai|co|me|info|biz|xyz|us|uk|rw|ng|ke|za|de|fr)$/;

const EVENT_KEYS = new Set(["schema", "id", "product", "kind", "occurredAt", "installId", "appVersion", "consent", "features", "prediction", "outcome"]);

/** True when `value` is a safe enum token: matches OUTCOME_ENUM_PATTERN and is not identifier-shaped. */
export function isOutcomeEnum(value: unknown): value is string {
  return typeof value === "string"
    && OUTCOME_ENUM_PATTERN.test(value)
    && !DIGIT_RUN.test(value)
    && !UUID_SHAPE.test(value)
    && !hasHexToken(value)
    && !HOST_LIKE.test(value);
}

export function validateOutcomeEvent(input: unknown, options: OutcomeValidationOptions = {}): OutcomeEventValidation {
  const errors: string[] = [];
  const fail = (path: string, message: string) => { errors.push(`${path}: ${message}`); };
  if (!isPlainObject(input)) return { ok: false, errors: ["event: must be an object"] };

  for (const key of Object.keys(input)) if (!EVENT_KEYS.has(key)) fail(key, "unknown field");

  if (input.schema !== OUTCOME_SCHEMA) fail("schema", `must be "${OUTCOME_SCHEMA}"`);
  if (!isUuidV4(input.id)) fail("id", "must be a lower-case UUID v4");
  if (!isUuidV4(input.installId)) fail("installId", "must be a lower-case UUID v4");

  const product = input.product;
  if (typeof product !== "string" || !Object.prototype.hasOwnProperty.call(OUTCOME_PRODUCT_KINDS, product)) {
    fail("product", "must be friday, orion or argus");
  } else if (input.kind !== OUTCOME_PRODUCT_KINDS[product as OutcomeProduct]) {
    fail("kind", `must be "${OUTCOME_PRODUCT_KINDS[product as OutcomeProduct]}" for ${product}`);
  }

  const occurredAt = isoUtcMillis(input.occurredAt);
  if (occurredAt === undefined) fail("occurredAt", "must be an ISO-8601 UTC timestamp");
  else if (options.now && occurredAt - options.now.getTime() > OUTCOME_MAX_FUTURE_SKEW_MS) fail("occurredAt", "is too far in the future");

  if (typeof input.appVersion !== "string" || !APP_VERSION.test(input.appVersion)) fail("appVersion", "must be a version token");

  if (!isPlainObject(input.consent)) fail("consent", "must be an object");
  else {
    checkKeys(input.consent, ["scope", "grantedAt"], "consent", fail);
    if (input.consent.scope !== "outcomes") fail("consent.scope", 'must be "outcomes"');
    if (isoUtcMillis(input.consent.grantedAt) === undefined) fail("consent.grantedAt", "must be an ISO-8601 UTC timestamp");
  }

  if (!isPlainObject(input.features)) fail("features", "must be an object");
  else {
    const keys = Object.keys(input.features);
    if (keys.length > OUTCOME_MAX_FEATURE_KEYS) fail("features", `must have at most ${OUTCOME_MAX_FEATURE_KEYS} keys`);
    for (const key of keys) {
      if (!isOutcomeEnum(key)) { fail("features", "keys must be enum tokens"); continue; }
      const value = input.features[key];
      const ok = typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || isOutcomeEnum(value);
      if (!ok) fail(`features.${key}`, "must be a finite number, boolean, or enum token");
    }
  }

  if (input.prediction !== undefined) {
    if (!isPlainObject(input.prediction)) fail("prediction", "must be an object");
    else {
      checkKeys(input.prediction, ["label", "p"], "prediction", fail);
      if (!isOutcomeEnum(input.prediction.label)) fail("prediction.label", "must be an enum token");
      const p = input.prediction.p;
      if (p !== undefined && !(typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1)) fail("prediction.p", "must be a number in [0, 1]");
    }
  }

  if (!isPlainObject(input.outcome)) fail("outcome", "is required and must be an object");
  else {
    checkKeys(input.outcome, ["label", "value"], "outcome", fail);
    if (!isOutcomeEnum(input.outcome.label)) fail("outcome.label", "must be an enum token");
    const value = input.outcome.value;
    if (value !== undefined && !(typeof value === "number" && Number.isFinite(value))) fail("outcome.value", "must be a finite number");
  }

  return errors.length === 0 ? { ok: true, value: input as OutcomeEvent } : { ok: false, errors };
}

export function validateOutcomeBatch(input: unknown, options: OutcomeBatchValidationOptions = {}): OutcomeBatchValidation {
  const rejectAll = (error: string): OutcomeBatchValidation => ({ ok: false, errors: [error], valid: [], invalid: [] });
  if (!isPlainObject(input)) return rejectAll("batch: must be an object");
  for (const key of Object.keys(input)) if (key !== "events") return rejectAll(`${key}: unknown field`);
  const events = input.events;
  if (!Array.isArray(events)) return rejectAll("events: must be an array");
  if (events.length < 1 || events.length > OUTCOME_MAX_BATCH_EVENTS) return rejectAll(`events: must contain 1..${OUTCOME_MAX_BATCH_EVENTS} events`);
  const bytes = options.byteLength ?? utf8Length(JSON.stringify(input));
  if (bytes > OUTCOME_MAX_BATCH_BYTES) return rejectAll(`batch: must be at most ${OUTCOME_MAX_BATCH_BYTES} bytes`);

  const valid: OutcomeEvent[] = [];
  const invalid: OutcomeBatchValidation["invalid"] = [];
  events.forEach((event, index) => {
    const result = validateOutcomeEvent(event, options);
    if (result.ok) valid.push(result.value);
    else {
      const id = isPlainObject(event) && isUuidV4(event.id) ? event.id : undefined;
      invalid.push({ index, ...(id ? { id } : {}), reason: result.errors.join("; ") });
    }
  });
  return { ok: invalid.length === 0, errors: [], valid, invalid };
}

function hasHexToken(value: string): boolean {
  // A long run mixing digits and a-f letters looks like a token or hash; "aaaa…" alone does not.
  return (value.match(HEX_RUN) ?? []).some((run) => /\d/.test(run) && /[a-f]/.test(run));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

function isoUtcMillis(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_UTC.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return undefined;
  const date = new Date(millis);
  // Date.parse normalises impossible dates (2026-02-30) on some engines; reject them explicitly.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return undefined;
  return millis;
}

function checkKeys(value: Record<string, unknown>, allowed: string[], path: string, fail: (path: string, message: string) => void): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, "unknown field");
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}
