import { describe, expect, it, vi } from "vitest";
import { mergeFreeCatalog, parseFreeOpenRouterModels } from "@archymedes/core/providers/free-catalog";
import { cachedEligibleModels } from "./catalog";

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, context_length: 4096, pricing: { prompt: "0", completion: "0" },
  architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"], ...extra });
const catalog = (rows: unknown[]) => mergeFreeCatalog(parseFreeOpenRouterModels({ data: rows }), [], 0);

describe("gateway catalog cache", () => {
  it("keeps only eligible concrete models, shares refreshes and serves the last good list on failure", async () => {
    let now = 0;
    const load = vi.fn(async () => catalog([row("lab/a:free"), row("lab/b:free", { supported_parameters: [] }), row("openrouter/free")]));
    const eligible = cachedEligibleModels({ load, ttlMs: 10, now: () => now });
    const [first, second] = await Promise.all([eligible(), eligible()]);
    expect([...first.keys()]).toEqual(["lab/a:free"]);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    now = 20;
    load.mockRejectedValueOnce(new Error("offline"));
    expect([...(await eligible()).keys()]).toEqual(["lab/a:free"]);
  });

  it("serves a stale list immediately while one background refresh replaces it, backing off after failures", async () => {
    let now = 0;
    let release!: () => void;
    const load = vi.fn(async () => catalog([row("lab/a:free")]));
    const eligible = cachedEligibleModels({ load, ttlMs: 100, retryMs: 30, now: () => now });
    await eligible();
    now = 150;
    load.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(catalog([row("lab/b:free")])); }));
    // Stale: answered from the cache without waiting, and concurrent callers share one refresh.
    expect([...(await eligible()).keys()]).toEqual(["lab/a:free"]);
    expect([...(await eligible()).keys()]).toEqual(["lab/a:free"]);
    expect(load).toHaveBeenCalledTimes(2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...(await eligible()).keys()]).toEqual(["lab/b:free"]);
    // A failed refresh keeps the last list and is not retried on every request.
    now = 300;
    load.mockRejectedValueOnce(new Error("offline"));
    await eligible();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await eligible();
    expect(load).toHaveBeenCalledTimes(3);
    now = 340; // past the retry delay
    await eligible();
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("fails when nothing verified has ever loaded", async () => {
    await expect(cachedEligibleModels({ load: async () => catalog([row("lab/paid:free", { pricing: { prompt: "1", completion: "0" } })]) })()).rejects.toThrow();
  });
});
