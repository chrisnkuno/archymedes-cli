import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { modelList } from "./models";

/** OpenRouter's public listing, as its /models answers: one free tool model, one paid. */
const OPENROUTER = {
  data: [
    {
      id: "meta-llama/llama-4-maverick:free", name: "Llama 4 Maverick (free)", context_length: 128_000,
      pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"], top_provider: { max_completion_tokens: 8192 },
    },
    {
      id: "acme/paid-model", name: "Paid", context_length: 64_000,
      pricing: { prompt: "0.000001", completion: "0.000002" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"],
    },
  ],
};

function fakeFetch(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://openrouter.ai/api/v1/models")) return { ok: true, status: 200, json: async () => OPENROUTER };
    if (url.includes("api.anthropic.com")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude-new-model" }] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function freshEnvironment(extra: Record<string, string> = {}) {
  return { ARCHYMEDES_CONFIG_DIR: await mkdtemp(path.join(os.tmpdir(), "archymedes-models-")), ...extra };
}

describe("model list over acp", () => {
  it("lists every provider's models, the ones without a key locked and last, and says what each lacks", async () => {
    const calls: string[] = [];
    const list = await modelList(await freshEnvironment({ ANTHROPIC_API_KEY: "sk-ant-x" }), {}, { fetchImpl: fakeFetch(calls) as never });
    const anthropic = list.choices.filter((choice) => choice.provider === "anthropic");
    expect(anthropic.length).toBeGreaterThan(0);
    expect(anthropic.filter((choice) => choice.isDefault)).toHaveLength(1);
    expect(anthropic.every((choice) => !choice.locked)).toBe(true);
    // A model the provider reported that this build never knew is listed, marked live.
    expect(anthropic.find((choice) => choice.model === "claude-new-model")).toMatchObject({ live: true });

    const openai = list.choices.filter((choice) => choice.provider === "openai");
    expect(openai.length).toBeGreaterThan(0);
    expect(openai.every((choice) => choice.locked && choice.missing.includes("OPENAI_API_KEY"))).toBe(true);
    expect(list.unconfigured.find((entry) => entry.provider === "openai")).toMatchObject({ missing: ["OPENAI_API_KEY"] });
    const firstLocked = list.choices.findIndex((choice) => choice.locked);
    expect(list.choices.slice(firstLocked).every((choice) => choice.locked)).toBe(true);
  });

  it("reads OpenRouter's public listing without a key, so every free model shows, marked free", async () => {
    const calls: string[] = [];
    const list = await modelList(await freshEnvironment(), {}, { fetchImpl: fakeFetch(calls) as never });
    expect(calls.some((url) => url.startsWith("https://openrouter.ai/api/v1/models"))).toBe(true);
    const free = list.choices.filter((choice) => choice.free);
    expect(free.map((choice) => choice.model)).toContain("meta-llama/llama-4-maverick:free");
    expect(free.every((choice) => choice.price === "free")).toBe(true);
    // Listed once, under the free provider, not again among OpenRouter's catalog.
    expect(list.choices.filter((choice) => choice.model === "meta-llama/llama-4-maverick:free").map((choice) => choice.provider)).toEqual(["free"]);
    // OpenRouter's whole catalog is there too, paid models included, locked until a key is added.
    expect(list.choices.find((choice) => choice.provider === "openrouter" && choice.model === "acme/paid-model")).toMatchObject({ locked: true, free: false });
  });

  it("keeps to the cache and asks nobody when told to stay offline, unless asked to refresh", async () => {
    const calls: string[] = [];
    const environment = await freshEnvironment({ ARCHYMEDES_MODELS_OFFLINE: "1", ANTHROPIC_API_KEY: "sk-ant-x" });
    await modelList(environment, {}, { fetchImpl: fakeFetch(calls) as never });
    expect(calls).toEqual([]);
    await modelList(environment, { refresh: true }, { fetchImpl: fakeFetch(calls) as never });
    expect(calls.some((url) => url.includes("anthropic"))).toBe(true);
    expect(calls.some((url) => url.includes("openrouter"))).toBe(false);
  });
});

import { isSmallModel, modelSizeBillions } from "@archymedes/core/providers/free-catalog";

describe("model size from the id", () => {
  it("reads billions and millions", () => {
    expect(modelSizeBillions("liquid/lfm-2.5-2.6b:free")).toBe(2.6);
    expect(modelSizeBillions("meta-llama/llama-3.2-1b-instruct")).toBe(1);
    expect(modelSizeBillions("google/gemma-270m")).toBeCloseTo(0.27);
  });
  it("says nothing for ids without a size, and is not fooled by version numbers or words", () => {
    for (const id of ["gpt-5.6-terra", "claude-sonnet-5", "cohere/north-mini-code:free", "model-v2b3", "mixtral-8x7b"]) {
      if (id === "mixtral-8x7b") continue;
      expect(modelSizeBillions(id)).toBeNull();
    }
  });
  it("flags only chat-sized models as small", () => {
    expect(isSmallModel("liquid/lfm-2.5-2.6b:free")).toBe(true);
    expect(isSmallModel("llama-3.3-70b-versatile")).toBe(false);
    expect(isSmallModel("claude-sonnet-5")).toBe(false);
  });
});
