import { describe, expect, it } from "vitest";
import { FREE_CATALOG_MAX_RECORDS, isFreeModelId, mergeFreeCatalog, parseFreeDiscovery, parseFreeOpenRouterModels } from "./free-catalog";
import { fetchFreeCatalog } from "./free-catalog-fetch";

const row = { id: "lab/code:free", name: "Code", context_length: 65536, top_provider: { max_completion_tokens: 8192 },
  pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools"] };

describe("free catalog policy", () => {
  it("accepts exact free IDs, not paid IDs or routing suffixes", () => {
    expect(isFreeModelId("openrouter/free")).toBe(true);
    expect(isFreeModelId(row.id)).toBe(true);
    for (const id of ["lab/code", "lab/code:free:online", "openrouter/auto", "https://evil/code:free", "lab/code:free\n", "lab/code:free/evil"]) expect(isFreeModelId(id)).toBe(false);
  });
  it("requires explicit zero prices, tools, text output and context", () => {
    expect(parseFreeOpenRouterModels({ data: [row] })[0]).toMatchObject({ eligible: true, context_window: 65536, max_output: 8192 });
    const invalid = [
      { pricing: { prompt: "0", completion: "0.01" } }, { pricing: { prompt: "0" } },
      { pricing: { prompt: "", completion: false } }, { pricing: { prompt: "0", completion: "0", request: "1" } },
      { supported_parameters: [] }, { architecture: { input_modalities: ["text"], output_modalities: ["audio"] } },
      { context_length: -1 },
    ];
    for (const override of invalid) expect(parseFreeOpenRouterModels({ data: [{ ...row, ...override }] })[0].eligible).toBe(false);
  });
  it("does not promote ambiguous duplicates or malformed inventories", () => {
    expect(parseFreeOpenRouterModels({ data: [row, row] })).toEqual([]);
    for (const data of [null, {}, { data: {} }, { data: Array(FREE_CATALOG_MAX_RECORDS + 1).fill(row) }]) expect(() => parseFreeOpenRouterModels(data)).toThrow();
  });
  it("retains discovery claims separately without trusting limits or publisher quotas", () => {
    const discovery = parseFreeDiscovery({ models: [{ id: row.id, name: "Claimed", provider: "Lab", context_window: 1_000_000,
      modalities: ["text", "vision"], rate_limit: "unlimited", source: "https://openrouter.ai/lab/code:free" }] });
    expect(discovery[0]).toMatchObject({ eligible: false, max_output: null });
    const catalog = mergeFreeCatalog(parseFreeOpenRouterModels({ data: [row] }), discovery, 42);
    expect(catalog.models[0]).toMatchObject({ eligible: true, context_window: 65536, rate_limit: "OpenRouter account quotas apply",
      discovery: { context_window: 1_000_000, rate_limit: "unlimited" } });
    expect(catalog.fetchedAt).toBe(42);
  });
  it("rejects unsafe discovery URLs and strips terminal control characters", () => {
    const item = { id: row.id, name: "\u001bBad\nname", source: "https://openrouter.ai/lab/code:free" };
    expect(parseFreeDiscovery({ models: [item] })[0].name).toBe("Badname");
    for (const source of ["http://openrouter.ai/x", "https://openrouter.ai.evil/x", "https://secret@openrouter.ai/x", "file:///etc/passwd"]) {
      expect(parseFreeDiscovery({ models: [{ ...item, source }] })).toEqual([]);
    }
  });
});

describe("bounded free catalog fetching", () => {
  it("fetches only fixed public URLs without credentials and tolerates discovery failure", async () => {
    const seen: string[] = [];
    const result = await fetchFreeCatalog({ fetchImpl: async (url, init) => {
      seen.push(url);
      expect(init?.headers).toEqual({ accept: "application/json" });
      expect(init?.redirect).toBe("error");
      if (url.includes("github")) throw new Error("offline");
      return Response.json({ data: [row] });
    } });
    expect(seen).toHaveLength(2);
    expect(result.models[0].eligible).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
  it("rejects oversized, malformed and unsuccessful responses", async () => {
    for (const response of [new Response("x".repeat(8 * 1024 * 1024 + 1)), new Response("not json"), new Response("down", { status: 503 })]) {
      await expect(fetchFreeCatalog({ discovery: false, fetchImpl: async () => response })).rejects.toThrow();
    }
  });
  it("propagates cancellation", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(fetchFreeCatalog({ signal: abort.signal, discovery: false, fetchImpl: async () => Response.json({ data: [row] }) })).rejects.toThrow();
  });
  it("bounds a fetch implementation that ignores its abort signal", async () => {
    await expect(fetchFreeCatalog({ timeoutMs: 5, discovery: false, fetchImpl: () => new Promise(() => undefined) })).rejects.toThrow();
  });
});
