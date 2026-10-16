import { describe, expect, it, vi } from "vitest";
import { FREE_ROUTER_PREFERENCE, mergeFreeCatalog, parseFreeOpenRouterModels, parseReasoning } from "./free-catalog";
import { freeModelProfile, freeRoutingTier } from "./free-model-profiles";
import { FreeAgentTurnProvider, freeReasoningFor } from "./free-agent";
import { FreeEndpointUptime, isEndpointDown, parseEndpointUptime } from "./free-endpoint-uptime";
import { orderByFreeHealth } from "./free-health";
import type { ChatResponse } from "./openai-compatible";

const listing = (id: string) => ({ id, context_length: 65_536, top_provider: { max_completion_tokens: 1_024 },
  pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] });
const catalogOf = (...ids: string[]) => () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: ids.map(listing) }), [], Date.now()));
const request = { messages: [{ role: "user" as const, content: "Read the file" }],
  tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }], maxOutputTokens: 4096, safetyIdentifier: "test" };
const answer = (model: string): ChatResponse => ({ id: "t", model, choices: [{ finish_reason: "stop", message: { content: "Done" } }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });

const APPS_ONLY = "thinkingmachines/inkling:free";
const SLOW = "nvidia/nemotron-3.5-lightning:free";
const AGENT = "cohere/north-mini-code:free";
const BUSY = "google/gemma-4-31b-it:free";

describe("free model profiles", () => {
  it("knows measured models and falls back to the id for the rest", () => {
    expect(freeModelProfile(AGENT).fit).toBe("agent");
    expect(freeModelProfile(APPS_ONLY).fit).toBe("apps-only");
    expect(freeModelProfile("lab/tiny-1.5b:free").fit).toBe("small");
    expect(freeModelProfile("lab/new-model:free").fit).toBe("unmeasured");
  });

  it("only prefers models measured as agents", () => {
    for (const id of FREE_ROUTER_PREFERENCE) expect(freeModelProfile(id).fit, id).toBe("agent");
  });

  it("orders by fit before health, and a never-routed model last", () => {
    const failing = { [AGENT]: { successes: 0, failures: 5, updatedAt: Date.now() } };
    const order = orderByFreeHealth([{ id: APPS_ONLY }, { id: SLOW }, { id: BUSY }, { id: "lab/new-model:free" }, { id: AGENT }], failing, Date.now());
    expect(order.map((model) => model.id)).toEqual([AGENT, "lab/new-model:free", BUSY, SLOW, APPS_ONLY]);
    expect(freeRoutingTier(APPS_ONLY)).toBeNull();
  });
});

describe("the free router and measured fit", () => {
  it("never sends a turn to a model only listed apps may use", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) => answer(String(body.model)));
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: catalogOf(APPS_ONLY, SLOW) });
    await provider.complete(request);
    expect(call.mock.calls.map(([body]) => body.model)).toEqual([SLOW]);
  });

  it("leaves slow models out while a fast one is listed", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) => {
      if (body.model === AGENT) throw Object.assign(new Error("busy"), { status: 429 });
      return answer(String(body.model));
    });
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: catalogOf(SLOW, AGENT) });
    await expect(provider.complete(request)).rejects.toThrow();
    expect(call.mock.calls.map(([body]) => body.model)).toEqual([AGENT]);
  });

  it("keeps a busy model as the fallback behind a refused agent", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) => {
      if (body.model === AGENT) throw Object.assign(new Error("busy"), { status: 429 });
      return answer(String(body.model));
    });
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: catalogOf(BUSY, SLOW, AGENT) });
    expect(await provider.complete(request)).toMatchObject({ content: "Done" });
    expect(call.mock.calls.map(([body]) => body.model)).toEqual([AGENT, BUSY]);
  });

  it("still honours a pinned model whatever its fit", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) => answer(String(body.model)));
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: APPS_ONLY }, { call, catalog: catalogOf(APPS_ONLY) });
    await provider.complete(request);
    expect(call.mock.calls[0][0].model).toBe(APPS_ONLY);
  });
});

describe("reasoning fitted to each model's listing", () => {
  it("reads the listing's reasoning object and ignores malformed fields", () => {
    expect(parseReasoning({ mandatory: false, default_enabled: true, supported_efforts: ["medium", "low", "none", "bogus"] }))
      .toEqual({ mandatory: false, defaultEnabled: true, efforts: ["medium", "low", "none"] });
    expect(parseReasoning({ default_enabled: true })).toBeUndefined();
  });

  it("does not switch reasoning on to save effort on a model that is off by default", () => {
    const gemma = { reasoning: { mandatory: false, defaultEnabled: false } };
    expect(freeReasoningFor(gemma, "minimal")).toBeUndefined();
    expect(freeReasoningFor(gemma, "low")).toBeUndefined();
    expect(freeReasoningFor(gemma, "high")).toEqual({ effort: "high" });
  });

  it("asks for the nearest level a model names, never none", () => {
    const nemotron = { reasoning: { mandatory: false, efforts: ["medium", "low", "none"] } };
    expect(freeReasoningFor(nemotron, "minimal")).toEqual({ effort: "low" });
    expect(freeReasoningFor(nemotron, "max")).toEqual({ effort: "medium" });
    expect(freeReasoningFor({ reasoning: { mandatory: true } }, "minimal")).toEqual({ effort: "minimal" });
    expect(freeReasoningFor(undefined, undefined)).toBeUndefined();
  });

  it("sends the fitted effort on the wire", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) => answer(String(body.model)));
    const listed = { ...listing(AGENT), reasoning: { mandatory: false, supported_efforts: ["medium", "low"] } };
    const catalog = () => Promise.resolve(mergeFreeCatalog(parseFreeOpenRouterModels({ data: [listed] }), [], Date.now()));
    await new FreeAgentTurnProvider({ apiKey: "k", model: AGENT }, { call, catalog }).complete({ ...request, effort: "minimal" });
    expect(call.mock.calls[0][0].reasoning).toEqual({ effort: "low" });
  });
});

describe("live endpoint uptime", () => {
  const endpoints = (last30m: number, last1d: number) => ({ data: { endpoints: [{ uptime_last_30m: last30m, uptime_last_1d: last1d }] } });

  it("reads the best endpoint and calls an endpoint down only on known low uptime", () => {
    expect(parseEndpointUptime({ data: { endpoints: [{ uptime_last_30m: 0 }, { uptime_last_30m: 90 }] } })).toEqual({ last30m: 90, last1d: undefined });
    expect(isEndpointDown({ last30m: 0, last1d: 99 })).toBe(true);
    expect(isEndpointDown({ last1d: 9.9 })).toBe(true);
    expect(isEndpointDown({ last30m: 70, last1d: 98 })).toBe(false);
    expect(isEndpointDown(undefined)).toBe(false);
  });

  it("waits only for figures it has never read, and serves stale ones while refreshing", async () => {
    let now = 0;
    let uptime = 0;
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => endpoints(uptime, 50) }));
    const tracker = new FreeEndpointUptime({ fetchImpl, now: () => now });
    expect(await tracker.down([SLOW])).toEqual(new Set([SLOW]));
    uptime = 100;
    now = 10 * 60_000;
    expect(await tracker.down([SLOW])).toEqual(new Set([SLOW]));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await tracker.down([SLOW])).toEqual(new Set());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a failed or slow read as not down", async () => {
    const tracker = new FreeEndpointUptime({ fetchImpl: () => new Promise(() => undefined), timeoutMs: 20 });
    expect(await tracker.down([AGENT])).toEqual(new Set());
  });

  it("moves a model whose endpoint is down behind the ones that are up", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) => answer(String(body.model)));
    const uptime = new FreeEndpointUptime({ fetchImpl: async (url) => ({ ok: true, json: async () => endpoints(url.includes("north-mini") ? 0 : 100, 100) }) });
    const second = "dots-studio/dots-3-note-preview:free";
    const provider = new FreeAgentTurnProvider({ apiKey: "k", model: "openrouter/free" }, { call, catalog: catalogOf(AGENT, second), uptime });
    await provider.complete(request);
    expect(call.mock.calls.map(([body]) => body.model)).toEqual([second]);
  });
});
