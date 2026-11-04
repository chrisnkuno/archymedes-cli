import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateOutcomeBatch } from "./outcome-protocol";
import {
  flushOutcomes,
  OUTCOME_QUEUE_LIMIT,
  outcomeNetworkBlocked,
  previewOutcomes,
  readOutcomeQueue,
  readOutcomeState,
  recordTaskOutcome,
  setOutcomeReporting,
  type OutcomeDependencies,
} from "./outcome-reporting";

type Call = { url: string; method: string; body?: unknown };

describe("opt-in outcome reporting", () => {
  let directory: string;
  let calls: Call[];
  let clock: number;
  let status: number | "throw";

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "friday-outcomes-"));
    calls = [];
    clock = Date.parse("2026-11-01T12:00:00Z");
    status = 202;
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  function deps(environment: Record<string, string | undefined> = { ARCHYMEDES_OUTCOMES_URL: "https://outcomes.example" }): OutcomeDependencies {
    return {
      environment,
      directory,
      now: () => clock,
      appVersion: "3.12.6",
      fetch: (async (input: string | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (status === "throw") throw new TypeError("fetch failed");
        return new Response(null, { status });
      }) as typeof fetch,
    };
  }
  const task = { engine: "archymedes", provider: "openai", model: "gpt-4o", status: "completed", toolCalls: 3, iterations: 2, elapsedMs: 9_000 };

  it("is off by default: nothing is queued and nothing is sent", async () => {
    expect((await readOutcomeState(deps())).enabled).toBe(false);
    expect(await recordTaskOutcome(task, deps())).toBe("off");
    expect(await readOutcomeQueue(deps())).toEqual([]);
    expect((await flushOutcomes(deps())).status).toBe("off");
    expect(calls).toEqual([]);
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });

  it("queues and sends only after an explicit `on`, with consent recorded", async () => {
    const state = await setOutcomeReporting(true, deps());
    expect(state).toMatchObject({ enabled: true, grantedAt: "2026-11-01T12:00:00.000Z" });
    expect(await recordTaskOutcome(task, deps())).toBe("queued");
    const [event] = await readOutcomeQueue(deps());
    expect(event).toMatchObject({ installId: state.installId, consent: { scope: "outcomes", grantedAt: state.grantedAt } });
    expect(await flushOutcomes(deps())).toMatchObject({ status: "sent", sent: 1 });
    expect(calls).toEqual([{ url: "https://outcomes.example/v1/outcomes", method: "POST", body: { events: [event] } }]);
    expect(await readOutcomeQueue(deps())).toEqual([]);
  });

  it.each([
    ["DO_NOT_TRACK", { DO_NOT_TRACK: "1" }],
    ["CI", { CI: "true" }],
    ["ARCHYMEDES_TELEMETRY=off", { ARCHYMEDES_TELEMETRY: "off" }],
  ])("respects %s: no recording and no network even when enabled", async (_name, extra) => {
    await setOutcomeReporting(true, deps());
    const blocked = deps({ ARCHYMEDES_OUTCOMES_URL: "https://outcomes.example", ...extra });
    expect(outcomeNetworkBlocked(blocked.environment)).toBeTruthy();
    expect(await recordTaskOutcome(task, blocked)).toBe("blocked");
    expect(await readOutcomeQueue(blocked)).toEqual([]);
    expect((await flushOutcomes(blocked)).status).toBe("blocked");
    await setOutcomeReporting(false, blocked);
    expect(calls).toEqual([]);
  });

  it("makes no network call when ARCHYMEDES_OUTCOMES_URL is unset", async () => {
    await setOutcomeReporting(true, deps({}));
    expect(await recordTaskOutcome(task, deps({}))).toBe("queued");
    expect((await flushOutcomes(deps({}))).status).toBe("no-url");
    expect(calls).toEqual([]);
  });

  it("flushes in batches of at most 100 and bounds the local queue", async () => {
    await setOutcomeReporting(true, deps());
    for (let index = 0; index < 150; index += 1) await recordTaskOutcome(task, deps());
    expect(await flushOutcomes(deps())).toMatchObject({ status: "sent", sent: 150 });
    expect(calls.map((call) => (call.body as { events: unknown[] }).events.length)).toEqual([100, 50]);
    for (const call of calls) expect(validateOutcomeBatch(call.body)).toMatchObject({ ok: true, errors: [] });

    for (let index = 0; index < OUTCOME_QUEUE_LIMIT + 25; index += 1) await recordTaskOutcome(task, deps({}));
    expect(await readOutcomeQueue(deps())).toHaveLength(OUTCOME_QUEUE_LIMIT);
    // About 1,175 real records, each a few small file operations: well inside 15 s on a quiet machine,
    // past it on a loaded one. The cost per record is the product's (one per finished task); the
    // count is only this test's, so the test gets the time, not the code a shortcut.
  }, 60_000);

  it("backs off after a failure, keeps the queue, and resets once a send lands", async () => {
    await setOutcomeReporting(true, deps());
    await recordTaskOutcome(task, deps());
    status = 503;
    expect((await flushOutcomes(deps())).status).toBe("failed");
    expect(await readOutcomeQueue(deps())).toHaveLength(1);
    const first = (await readOutcomeState(deps())).backoff!;
    expect(first.failures).toBe(1);
    expect(first.nextAttemptAt).toBeGreaterThan(clock);

    expect((await flushOutcomes(deps())).status).toBe("backoff");
    expect(calls).toHaveLength(1);

    clock = first.nextAttemptAt;
    status = "throw";
    expect((await flushOutcomes(deps())).status).toBe("failed");
    const second = (await readOutcomeState(deps())).backoff!;
    expect(second.failures).toBe(2);
    expect(second.nextAttemptAt - clock).toBeGreaterThan(first.nextAttemptAt - Date.parse("2026-11-01T12:00:00Z"));

    clock = second.nextAttemptAt;
    status = 202;
    expect(await flushOutcomes(deps())).toMatchObject({ status: "sent", sent: 1 });
    expect((await readOutcomeState(deps())).backoff).toBeUndefined();
  });

  it("drops a batch the server refuses as invalid instead of retrying it forever", async () => {
    await setOutcomeReporting(true, deps());
    await recordTaskOutcome(task, deps());
    status = 422;
    expect((await flushOutcomes(deps())).status).toBe("sent");
    expect(await readOutcomeQueue(deps())).toEqual([]);
  });

  it("keeps the queue when the service refuses for its own reasons (auth, wrong path), and retries later", async () => {
    await setOutcomeReporting(true, deps());
    await recordTaskOutcome(task, deps());
    for (const refusal of [401, 403, 404]) {
      status = refusal;
      expect((await flushOutcomes(deps())).status).toBe("failed");
      expect(await readOutcomeQueue(deps())).toHaveLength(1);
      clock += 24 * 60 * 60 * 1000;
    }
    status = 202;
    expect(await flushOutcomes(deps())).toMatchObject({ status: "sent", sent: 1 });
  });

  it("`off` requests erasure, clears the queue and rotates the install id", async () => {
    const on = await setOutcomeReporting(true, deps());
    await recordTaskOutcome(task, deps());
    const off = await setOutcomeReporting(false, deps());
    expect(off.enabled).toBe(false);
    expect(off.grantedAt).toBeUndefined();
    expect(off.installId).not.toBe(on.installId);
    expect(await readOutcomeQueue(deps())).toEqual([]);
    expect(calls).toEqual([{ url: `https://outcomes.example/v1/outcomes/install/${on.installId}`, method: "DELETE" }]);
    expect(off.pendingErasure).toEqual([]);
  });

  it("keeps an erasure request that could not be delivered and retries it on a later flush", async () => {
    const on = await setOutcomeReporting(true, deps());
    status = 503;
    const off = await setOutcomeReporting(false, deps());
    expect(off.pendingErasure).toEqual([on.installId]);
    status = 204;
    await flushOutcomes(deps());
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `DELETE https://outcomes.example/v1/outcomes/install/${on.installId}`,
      `DELETE https://outcomes.example/v1/outcomes/install/${on.installId}`,
    ]);
    expect((await readOutcomeState(deps())).pendingErasure).toEqual([]);
  });

  it("previews exactly the request body a flush would send", async () => {
    await setOutcomeReporting(true, deps());
    await recordTaskOutcome(task, deps());
    const preview = await previewOutcomes(deps());
    expect(preview).toMatchObject({ url: "https://outcomes.example/v1/outcomes", sample: false });
    await flushOutcomes(deps());
    expect(calls[0]!.body).toEqual(preview.body);
  });

  it("previews a labelled sample when nothing is queued, without touching disk or network", async () => {
    const preview = await previewOutcomes(deps({}));
    expect(preview.sample).toBe(true);
    expect(preview.url).toBeUndefined();
    expect(preview.body.events).toHaveLength(1);
    expect(calls).toEqual([]);
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });

  it("keeps every batch under the service's 64 KiB body limit", async () => {
    await setOutcomeReporting(true, deps());
    const heavy = { ...task, routingReceipts: [{ chosen: { model: "m" }, considered: [], policy: {}, retries: 1, predictedOutcomeScore: 0.123456789, outcomeScore: 0.5 }], effort: "medium", actualModelRwf: 500 };
    for (let index = 0; index < 100; index += 1) await recordTaskOutcome(heavy, deps());
    await flushOutcomes(deps());
    for (const call of calls) expect(new TextEncoder().encode(JSON.stringify(call.body)).length).toBeLessThanOrEqual(64 * 1024);
    expect(calls.flatMap((call) => (call.body as { events: unknown[] }).events)).toHaveLength(100);
  });
});
