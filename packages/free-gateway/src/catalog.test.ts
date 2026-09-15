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

  it("fails when nothing verified has ever loaded", async () => {
    await expect(cachedEligibleModels({ load: async () => catalog([row("lab/paid:free", { pricing: { prompt: "1", completion: "0" } })]) })()).rejects.toThrow();
  });
});
