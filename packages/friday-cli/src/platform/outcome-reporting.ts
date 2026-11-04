import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Environment } from "./environment";
import { cueOptedOut } from "./install-cue";
import { OUTCOME_MAX_BATCH_BYTES } from "./outcome-protocol";
import { buildOutcomeEvent, isPublicModelId, validateOutcomeEvent, type OutcomeBatch, type OutcomeEvent, type TaskOutcomeInput } from "./outcomes";
import { settingsDirectory } from "./settings";
import { ARCHYMEDES_CLI_VERSION } from "./update";

/**
 * Opt-in outcome reporting: consent, a local queue, and batched delivery.
 *
 * Off unless the person ran `friday outcomes on` (or set `"enabled": true` in `outcomes.json` beside
 * settings.json). When on, each finished task becomes one `archymedes.outcome/v1` event (outcomes.ts
 * decides what is in it) appended to a bounded local queue, and the queue is sent in batches of at
 * most 100 to `${ARCHYMEDES_OUTCOMES_URL}/v1/outcomes`. There is no default URL: with the variable
 * unset nothing ever leaves the machine. `DO_NOT_TRACK`, CI, a test run and `ARCHYMEDES_TELEMETRY=off`
 * stop both recording and every network call, consent or not.
 *
 * `friday outcomes off` asks the service to erase everything sent under the current install id,
 * clears the queue, and rotates the id, so anything reported later cannot be joined to what came
 * before. An erasure that could not be delivered is remembered and retried on later flushes.
 *
 * Nothing here blocks the interface: callers fire `reportTaskOutcome` and do not await it, each
 * request gives up after five seconds, and failures back off exponentially (30 s doubling, to six
 * hours). Two processes flushing at once can send an event twice; event ids are UUIDs, so the
 * service deduplicates.
 */

export const OUTCOME_QUEUE_LIMIT = 1_000;
export const OUTCOME_BATCH_LIMIT = 100;
const STATE_FILE = "outcomes.json";
const QUEUE_FILE = "outcomes-queue.jsonl";
const TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1_000;

export type OutcomeState = {
  schemaVersion: 1;
  enabled: boolean;
  /** Per-install, random, never an account id; rotated by `off`. */
  installId: string;
  grantedAt?: string;
  /** Install ids whose erasure has been asked for but not yet confirmed by the service. */
  pendingErasure: string[];
  backoff?: { failures: number; nextAttemptAt: number };
};

export type OutcomeDependencies = {
  environment: Environment;
  /** Where state and queue live; the settings directory by default. */
  directory?: string;
  fetch?: typeof fetch;
  now?: () => number;
  appVersion?: string;
};

const directoryOf = (deps: OutcomeDependencies) => deps.directory ?? settingsDirectory(deps.environment);
const nowOf = (deps: OutcomeDependencies) => (deps.now ?? Date.now)();

/** Why no outcome may be recorded or sent here, whatever the consent; undefined when nothing stops it. */
export function outcomeNetworkBlocked(environment: Environment): string | undefined {
  const doNotTrack = environment.DO_NOT_TRACK?.trim();
  if (doNotTrack && doNotTrack !== "0" && doNotTrack.toLowerCase() !== "false") return "DO_NOT_TRACK is set";
  if (environment.CI?.trim()) return "running in CI";
  return cueOptedOut(environment) ? "telemetry is off (ARCHYMEDES_TELEMETRY=off or a test run)" : undefined;
}

/** The service base URL, or undefined: there is deliberately no built-in default. */
export function outcomesEndpoint(environment: Environment): string | undefined {
  const raw = environment.ARCHYMEDES_OUTCOMES_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch { return undefined; }
}

function freshState(): OutcomeState {
  return { schemaVersion: 1, enabled: false, installId: randomUUID(), pendingErasure: [] };
}

export async function readOutcomeState(deps: OutcomeDependencies): Promise<OutcomeState> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(directoryOf(deps), STATE_FILE), "utf8")) as Partial<OutcomeState>;
    const installId = typeof parsed.installId === "string" && /^[0-9a-f-]{36}$/.test(parsed.installId) ? parsed.installId : randomUUID();
    return {
      schemaVersion: 1,
      enabled: parsed.enabled === true && typeof parsed.grantedAt === "string",
      installId,
      ...(typeof parsed.grantedAt === "string" ? { grantedAt: parsed.grantedAt } : {}),
      pendingErasure: Array.isArray(parsed.pendingErasure) ? parsed.pendingErasure.filter((id): id is string => typeof id === "string") : [],
      ...(parsed.backoff && typeof parsed.backoff.failures === "number" && typeof parsed.backoff.nextAttemptAt === "number" ? { backoff: parsed.backoff } : {}),
    };
  } catch {
    return freshState();
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}

async function writeState(deps: OutcomeDependencies, state: OutcomeState): Promise<void> {
  await atomicWrite(path.join(directoryOf(deps), STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readOutcomeQueue(deps: OutcomeDependencies): Promise<OutcomeEvent[]> {
  let text: string;
  try { text = await fs.readFile(path.join(directoryOf(deps), QUEUE_FILE), "utf8"); } catch { return []; }
  const events: OutcomeEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as OutcomeEvent;
      if (validateOutcomeEvent(event).length === 0) events.push(scrubModel(event));
    } catch { /* a torn line from a crash mid-write is dropped, not sent */ }
  }
  return events.slice(-OUTCOME_QUEUE_LIMIT);
}

/**
 * Events queued by an earlier version were built under an earlier rule for model ids. The queue is
 * re-checked on every read, so whatever is previewed or sent obeys the current rule, not the one in
 * force when the event was written.
 */
function scrubModel(event: OutcomeEvent): OutcomeEvent {
  const model = event.features?.model;
  if (typeof model !== "string" || isPublicModelId(model)) return event;
  return { ...event, features: { ...event.features, model: "custom" } };
}

async function writeQueue(deps: OutcomeDependencies, events: readonly OutcomeEvent[]): Promise<void> {
  const file = path.join(directoryOf(deps), QUEUE_FILE);
  if (events.length === 0) { await fs.rm(file, { force: true }); return; }
  await atomicWrite(file, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}

/** `friday outcomes on|off`. Off also requests erasure, clears the queue and rotates the install id. */
export async function setOutcomeReporting(enabled: boolean, deps: OutcomeDependencies): Promise<OutcomeState> {
  const current = await readOutcomeState(deps);
  if (enabled) {
    const next: OutcomeState = { ...current, enabled: true, grantedAt: current.enabled && current.grantedAt ? current.grantedAt : new Date(nowOf(deps)).toISOString() };
    await writeState(deps, next);
    return next;
  }
  const { grantedAt: _granted, backoff: _backoff, ...rest } = current;
  const next: OutcomeState = {
    ...rest,
    enabled: false,
    installId: randomUUID(),
    pendingErasure: [...new Set([...current.pendingErasure, current.installId])],
  };
  await writeState(deps, next);
  await writeQueue(deps, []);
  return { ...next, pendingErasure: await sendErasures(deps, next) };
}

/** Delivers pending erasure requests; returns (and persists) the ones still pending. */
async function sendErasures(deps: OutcomeDependencies, state: OutcomeState): Promise<string[]> {
  const endpoint = outcomesEndpoint(deps.environment);
  if (state.pendingErasure.length === 0 || !endpoint || outcomeNetworkBlocked(deps.environment)) return state.pendingErasure;
  const fetcher = deps.fetch ?? fetch;
  const remaining: string[] = [];
  for (const installId of state.pendingErasure) {
    try {
      const response = await fetcher(`${endpoint}/v1/outcomes/install/${encodeURIComponent(installId)}`, { method: "DELETE", signal: AbortSignal.timeout(TIMEOUT_MS) });
      // 404: nothing was ever stored under it, which is what erasure wants.
      if (!(response.ok || response.status === 404)) remaining.push(installId);
    } catch { remaining.push(installId); }
  }
  if (remaining.length !== state.pendingErasure.length) await writeState(deps, { ...(await readOutcomeState(deps)), pendingErasure: remaining });
  return remaining;
}

export type RecordOutcome = "off" | "blocked" | "queued" | "invalid";

/** Appends the task's event to the local queue when reporting is on and nothing forbids it. */
export async function recordTaskOutcome(input: TaskOutcomeInput, deps: OutcomeDependencies): Promise<RecordOutcome> {
  if (outcomeNetworkBlocked(deps.environment)) return "blocked";
  const state = await readOutcomeState(deps);
  if (!state.enabled || !state.grantedAt) return "off";
  const event = buildOutcomeEvent(input, { installId: state.installId, grantedAt: state.grantedAt, appVersion: deps.appVersion ?? ARCHYMEDES_CLI_VERSION, now: nowOf(deps) });
  if (validateOutcomeEvent(event).length > 0) return "invalid";
  // Appended, not rewritten: a task end costs one small write however long the queue is. The bound
  // (oldest out first) is what keeps an offline machine from growing the file forever; it is applied
  // exactly on read and compacted on disk once the file is clearly past it.
  const file = path.join(directoryOf(deps), QUEUE_FILE);
  const line = `${JSON.stringify(event)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  const { size } = await fs.stat(file);
  if (size > line.length * OUTCOME_QUEUE_LIMIT * 1.25) await writeQueue(deps, await readOutcomeQueue(deps));
  return "queued";
}

export type FlushResult = { status: "off" | "blocked" | "no-url" | "backoff" | "empty" | "sent" | "failed"; sent: number };

/** Sends what is queued, oldest first, in batches; backs off on failure. */
export async function flushOutcomes(deps: OutcomeDependencies): Promise<FlushResult> {
  if (outcomeNetworkBlocked(deps.environment)) return { status: "blocked", sent: 0 };
  const endpoint = outcomesEndpoint(deps.environment);
  let state = await readOutcomeState(deps);
  if (state.pendingErasure.length > 0 && endpoint) state = { ...state, pendingErasure: await sendErasures(deps, state) };
  if (!state.enabled) return { status: "off", sent: 0 };
  if (!endpoint) return { status: "no-url", sent: 0 };
  const now = nowOf(deps);
  if (state.backoff && now < state.backoff.nextAttemptAt) return { status: "backoff", sent: 0 };

  const fetcher = deps.fetch ?? fetch;
  let sent = 0;
  for (;;) {
    const queue = await readOutcomeQueue(deps);
    if (queue.length === 0) break;
    const batch = nextBatch(queue);
    let retry: boolean;
    try {
      const response = await fetcher(`${endpoint}/v1/outcomes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
      // Only a rejection of the batch's own content (bad request, too large, unprocessable) means it will
      // never be accepted: drop it. Any other failure (auth, a wrong path, throttling, an outage) is
      // about the service, not the data, so the events stay queued and the send is retried later.
      retry = !response.ok && ![400, 413, 422].includes(response.status);
    } catch { retry = true; }
    if (retry) {
      const failures = (state.backoff?.failures ?? 0) + 1;
      await writeState(deps, { ...(await readOutcomeState(deps)), backoff: { failures, nextAttemptAt: now + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)) } });
      return { status: "failed", sent };
    }
    // Remove exactly what was sent, keeping anything appended while the request was in flight.
    const sentIds = new Set(batch.events.map((event) => event.id));
    await writeQueue(deps, (await readOutcomeQueue(deps)).filter((event) => !sentIds.has(event.id)));
    sent += batch.events.length;
  }
  if (state.backoff) {
    const { backoff: _cleared, ...rest } = await readOutcomeState(deps);
    await writeState(deps, rest);
  }
  return { status: sent > 0 ? "sent" : "empty", sent };
}

/** The oldest events that fit one request: at most 100, and at most the service's 64 KiB body. */
function nextBatch(queue: readonly OutcomeEvent[]): OutcomeBatch {
  const events: OutcomeEvent[] = [];
  let bytes = Buffer.byteLength('{"events":[]}');
  for (const event of queue.slice(0, OUTCOME_BATCH_LIMIT)) {
    const size = Buffer.byteLength(JSON.stringify(event)) + (events.length > 0 ? 1 : 0);
    if (events.length > 0 && bytes + size > OUTCOME_MAX_BATCH_BYTES) break;
    events.push(event);
    bytes += size;
  }
  return { events };
}

/** Record then flush, for a task end. Never throws; the caller does not await it. */
export async function reportTaskOutcome(input: TaskOutcomeInput, deps: OutcomeDependencies): Promise<void> {
  try {
    if (await recordTaskOutcome(input, deps) === "queued") await flushOutcomes(deps);
  } catch { /* reporting must never disturb the session */ }
}

export type OutcomePreview = { url?: string; sample: boolean; body: OutcomeBatch };

/**
 * `friday outcomes preview`: the exact body the next flush would POST. With nothing queued, a sample
 * event built from a representative task, labelled as such. Reads only; never writes or sends.
 */
export async function previewOutcomes(deps: OutcomeDependencies): Promise<OutcomePreview> {
  const endpoint = outcomesEndpoint(deps.environment);
  const url = endpoint ? `${endpoint}/v1/outcomes` : undefined;
  const queue = await readOutcomeQueue(deps);
  if (queue.length > 0) return { ...(url ? { url } : {}), sample: false, body: nextBatch(queue) };
  const state = await readOutcomeState(deps);
  const now = nowOf(deps);
  const event = buildOutcomeEvent(
    { engine: "archymedes", provider: "anthropic", model: "claude-sonnet-4.5", effort: "medium", status: "completed", toolCalls: 6, iterations: 4, repairs: 0, elapsedMs: 48_000, actualModelRwf: 420 },
    { installId: state.installId, grantedAt: state.grantedAt ?? new Date(now).toISOString(), appVersion: deps.appVersion ?? ARCHYMEDES_CLI_VERSION, now },
  );
  return { ...(url ? { url } : {}), sample: true, body: { events: [event] } };
}
