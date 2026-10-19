import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../platform/settings";
import { connectProvider, providerFields, providerModels, rememberModel } from "./connect";

let dir: string;
let processEnvironment: Record<string, string | undefined>;
let environment: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-connect-"));
  processEnvironment = { ARCHYMEDES_CONFIG_DIR: dir };
  environment = { ...processEnvironment };
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

/** A provider endpoint: the models for a good key, 401 otherwise; records what it was asked. */
function provider(goodKey: string, models = ["gpt-a", "gpt-b"]) {
  const asked: Array<{ url: string; auth?: string }> = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.authorization;
    asked.push({ url, ...(auth ? { auth } : {}) });
    const ok = auth === `Bearer ${goodKey}`;
    return { ok, status: ok ? 200 : 401, json: async () => ({ data: models.map((id) => ({ id })) }) };
  };
  return { asked, fetchImpl };
}

describe("providerFields", () => {
  it("is the key the provider requires, then its base URL with the default as the hint", () => {
    const fields = providerFields("openai", { OPENAI_API_KEY: "sk-secret-value-123" });
    expect(fields.map((field) => [field.key, field.kind, field.required])).toEqual([["OPENAI_API_KEY", "secret", true], ["OPENAI_BASE_URL", "url", false]]);
    expect(fields[0]).toMatchObject({ isSet: true });
    expect(fields[0].value).not.toContain("secret-value");
    expect(fields[1].placeholder).toBe("https://api.openai.com/v1");
  });
  it("asks an OpenAI-compatible endpoint for both its key and its URL, and Ollama only for a URL", () => {
    expect(providerFields("openai-compatible", {}).filter((field) => field.required).map((field) => field.key)).toEqual(["OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"]);
    expect(providerFields("ollama", {}).map((field) => field.key)).toEqual(["OLLAMA_BASE_URL"]);
    expect(providerFields("free", {}).map((field) => field.key)).toEqual(["OPENROUTER_API_KEY"]);
  });
});

describe("connectProvider", () => {
  it("checks the key by listing the provider's models, saves it, and returns them", async () => {
    const { fetchImpl, asked } = provider("sk-good");
    const result = await connectProvider({ provider: "openai", values: { OPENAI_API_KEY: "sk-good" } }, { environment, processEnvironment, fetchImpl });
    expect(result).toMatchObject({ ok: true, models: ["gpt-a", "gpt-b"] });
    expect(asked[0].url).toBe("https://api.openai.com/v1/models");
    expect((await loadSettings(processEnvironment)).OPENAI_API_KEY).toBe("sk-good");
    expect(environment.OPENAI_API_KEY).toBe("sk-good");
  });

  it("refuses a key the provider refuses, and saves nothing", async () => {
    const { fetchImpl } = provider("sk-good");
    const result = await connectProvider({ provider: "openai", values: { OPENAI_API_KEY: "sk-bad" } }, { environment, processEnvironment, fetchImpl });
    expect(result).toMatchObject({ ok: false, field: "OPENAI_API_KEY", error: expect.stringContaining("refused the key") });
    expect((await loadSettings(processEnvironment)).OPENAI_API_KEY).toBeUndefined();
  });

  it("uses the base URL given, keeps a saved key when the field is left empty, and an empty URL goes back to the default", async () => {
    const { fetchImpl, asked } = provider("sk-good");
    await connectProvider({ provider: "openai", values: { OPENAI_API_KEY: "sk-good", OPENAI_BASE_URL: "https://proxy.example.com/v1" } }, { environment, processEnvironment, fetchImpl });
    expect(asked.at(-1)!.url).toBe("https://proxy.example.com/v1/models");
    const again = await connectProvider({ provider: "openai", values: { OPENAI_API_KEY: "", OPENAI_BASE_URL: "" } }, { environment, processEnvironment, fetchImpl });
    expect(again.ok).toBe(true);
    const saved = await loadSettings(processEnvironment);
    expect(saved.OPENAI_API_KEY).toBe("sk-good");
    expect(saved.OPENAI_BASE_URL).toBeUndefined();
    expect(asked.at(-1)!.url).toBe("https://api.openai.com/v1/models");
  });

  it("says what is still missing and which field, and rejects a malformed URL before asking anyone", async () => {
    const { fetchImpl, asked } = provider("k");
    expect(await connectProvider({ provider: "openai-compatible", values: { OPENAI_COMPATIBLE_API_KEY: "k" } }, { environment, processEnvironment, fetchImpl }))
      .toMatchObject({ ok: false, field: "OPENAI_COMPATIBLE_BASE_URL", error: expect.stringContaining("still needs") });
    expect(await connectProvider({ provider: "openai-compatible", values: { OPENAI_COMPATIBLE_API_KEY: "k", OPENAI_COMPATIBLE_BASE_URL: "not a url" } }, { environment, processEnvironment, fetchImpl }))
      .toMatchObject({ ok: false, field: "OPENAI_COMPATIBLE_BASE_URL" });
    expect(asked).toHaveLength(0);
  });

  it("saves with a note when the provider cannot be reached (it says nothing about the key)", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    const result = await connectProvider({ provider: "ollama", values: { OLLAMA_BASE_URL: "http://localhost:9/v1" } }, { environment, processEnvironment, fetchImpl });
    expect(result).toMatchObject({ ok: true, models: [], note: expect.stringContaining("Could not list") });
  });

  it("checks an OpenRouter key with OpenRouter, since its model list is public", async () => {
    const { fetchImpl } = provider("ignored");
    const bad = await connectProvider({ provider: "openrouter", values: { OPENROUTER_API_KEY: "sk-or-bad" } }, {
      environment, processEnvironment, fetchImpl, checkOpenRouter: async () => ({ ok: false, reason: "invalid", status: 401 }) as never,
    });
    expect(bad).toMatchObject({ ok: false, field: "OPENROUTER_API_KEY" });
  });
});

describe("providerModels and rememberModel", () => {
  it("lists a configured provider's models from the provider", async () => {
    environment.OPENAI_API_KEY = "sk-good";
    const { fetchImpl } = provider("sk-good", ["gpt-z"]);
    expect(await providerModels({ provider: "openai" }, { environment, fetchImpl })).toEqual({ models: ["gpt-z"] });
  });
  it("remembers the model picked for the provider, for the next session", async () => {
    expect(await rememberModel({ provider: "openai", model: "gpt-b" }, { environment, processEnvironment })).toEqual({ ok: true });
    expect((await loadSettings(processEnvironment)).OPENAI_MODEL).toBe("gpt-b");
    expect(environment.OPENAI_MODEL).toBe("gpt-b");
  });
});
