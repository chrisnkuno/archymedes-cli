/**
 * WS-50.3 and WS-50.4: captures what the TypeScript agent answers about providers and models, once.
 *
 *   bun run tooling/port/providers-fixtures.ts
 *
 * Writes internal/core/llm/testdata/catalog.json (known models, prices, free-model fit, ids, model
 * listings) and internal/core/server/testdata/providers.json (setup status, the Providers app's
 * rows, connect, save, remember and the model list, on fixed environments and a fake network). The
 * Go ports are tested against them, so the contract outlives the TypeScript code (deleted in
 * WS-50.10, with this script).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { PROVIDER_IDS, catalogPrices, type ProviderId } from "../../packages/core/src/providers/agent-matrix";
import { isFreeModelId, isSmallModel, modelSizeBillions, parseFreeDiscovery, parseFreeOpenRouterModels, mergeFreeCatalog } from "../../packages/core/src/providers/free-catalog";
import { freeModelProfile } from "../../packages/core/src/providers/free-model-profiles";
import { isConversationalModel, modelsEndpoint, parseModelsResponse } from "../../packages/core/src/providers/model-list";
import { describeKeyCheckFailure, parseOpenRouterKeyInfo } from "../../packages/core/src/providers/openrouter-key-info";
import { priceAliases } from "../../packages/core/src/pricing";
import { describePrice, modelsForProvider } from "../../packages/friday-cli/src/session/models";
import { providerOverview, saveSetup, setupStatus } from "../../packages/friday-cli/src/server/setup";
import { connectProvider, providerModels, rememberModel } from "../../packages/friday-cli/src/server/connect";
import { modelList } from "../../packages/friday-cli/src/server/models";

const here = path.dirname(fileURLToPath(import.meta.url));
const write = (dir: string, name: string, value: unknown) => {
  const out = path.join(here, "../..", dir, "testdata");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 1)}\n`);
};
const asOf = "2026-11-06";

// ---- the catalog: pure data and rules --------------------------------------------------------

const probeModels = [
  "claude-sonnet-5", "claude-sonnet-5-20260514", "claude-sonnet-5-latest", "claude-sonnet-5-preview-latest", "claude-opus-5",
  "claude-haiku-4-5-20251001", "gemini-2.5-pro", "gemini-2.5-flash-preview", "grok-4", "deepseek-chat", "llama-3.3-70b-versatile",
  "gpt-5.6-terra", "unknown-model", "openrouter/free", "a/b:free", "llama3.1", "mistral-large-latest",
];
const known: Record<string, string[]> = {};
const prices: Array<{ provider: string; model: string; asOf: string; price: string; input?: number; output?: number; cached?: number }> = [];
for (const provider of PROVIDER_IDS) {
  known[provider] = modelsForProvider(provider);
  for (const model of [...new Set([...known[provider], ...probeModels])]) {
    for (const date of [asOf, "2026-08-01"]) {
      const p = catalogPrices(provider, model, date);
      prices.push({ provider, model, asOf: date, price: describePrice(p, p?.currency ?? "USD", (value) => value),
        ...(p ? { input: p.inputPerMillion, output: p.outputPerMillion, ...(p.cachedInputPerMillion !== undefined ? { cached: p.cachedInputPerMillion } : {}) } : {}) });
    }
  }
}

const ids = [
  "openrouter/free", "a/b:free", "meta-llama/llama-4-maverick:free", "A/B:FREE", "a/b:free:free", "/x:free", "a/:free", "x:free",
  "liquid/lfm-2.5-2.6b:free", "meta-llama/llama-3.2-1b-instruct", "google/gemma-270m", "gpt-5.6-terra", "claude-sonnet-5",
  "cohere/north-mini-code:free", "model-v2b3", "llama-3.3-70b-versatile", "qwen-0.5b", "x/qwen3-4b:free", "x/model-4.5b:free",
  "x/a-3b-7b", "x/1.5m", "nvidia/nemotron-3.5-super-vl:free", "thinkingmachines/inkling:free", "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3.5-lightning:free", "text-embedding-3-large", "whisper-1", "gpt-4o-realtime-preview", "omni-moderation-latest",
  "davinci-002", "codex-mini-latest", "llama-guard-3", "dall-e-3", "stable-diffusion", "gpt-4o-transcribe", "tts-1", "gpt-image-1",
  "mistral-embed", "orpheus-v1", "babbage-002", "text-search-ada", "rerank-v3", "gpt-4o-audio-preview", "nvidia/nemotron-3-ultra-550b-a55b:free",
  "a".repeat(250) + "/b:free", "a".repeat(260) + "/b:free",
  ...Object.keys({}),
];
const models = ids.map((id) => ({
  id, free: isFreeModelId(id), size: modelSizeBillions(id), small: isSmallModel(id), conversational: isConversationalModel(id),
  aliases: priceAliases(id), ...freeModelProfile(id),
}));

const envs: Record<string, Record<string, string>> = {
  none: {},
  keys: {
    ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "sk-or", GOOGLE_API_KEY: "g", XAI_API_KEY: "x",
    DEEPSEEK_API_KEY: "d", MISTRAL_API_KEY: "m", GROQ_API_KEY: "q", OPENAI_COMPATIBLE_API_KEY: "c",
  },
  bases: {
    ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "https://proxy.example/", OPENAI_API_KEY: "sk-oa", OPENAI_BASE_URL: "https://oa.example/v1/",
    OPENROUTER_BASE_URL: "https://or.example/api/v1", GROQ_API_KEY: "q", GROQ_BASE_URL: "https://groq.example",
    OPENAI_COMPATIBLE_API_KEY: "c", OPENAI_COMPATIBLE_BASE_URL: "https://compat.example/v1", OLLAMA_BASE_URL: "http://box:11434",
  },
  compatNoBase: { OPENAI_COMPATIBLE_API_KEY: "c" },
};
const endpoints: Array<{ env: string; provider: string; url?: string; headers?: Record<string, string> }> = [];
for (const [name, env] of Object.entries(envs)) {
  for (const provider of PROVIDER_IDS) {
    const e = modelsEndpoint(provider, env);
    endpoints.push({ env: name, provider, ...(e ? { url: e.url, headers: e.headers } : {}) });
  }
}

const listingBodies: unknown[] = [
  { data: [{ id: "b" }, { id: "a" }, { name: "c" }, "d", { id: 5 }, null, { id: "a" }] },
  [{ id: "x" }, "y"],
  { models: [{ name: "llama3.1:8b" }, { name: "qwen" }] },
  { nothing: true },
  "text",
];
const listings = listingBodies.map((body) => ({ body, ids: parseModelsResponse(body) }));

const openRouterBody = {
  data: [
    { id: "meta-llama/llama-4-maverick:free", name: "Llama 4\u0007 Maverick", context_length: 128_000, pricing: { prompt: "0", completion: "0" },
      architecture: { input_modalities: ["text", "image", "text"], output_modalities: ["text"] }, supported_parameters: ["tools", "temperature"],
      top_provider: { max_completion_tokens: 8192 }, reasoning: { mandatory: false, default_enabled: true, supported_efforts: ["low", "bogus", "high"] } },
    { id: "acme/paid:free", pricing: { prompt: "0.000001", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"], context_length: 1000 },
    { id: "acme/notools:free", pricing: { prompt: 0, completion: "0.0" }, architecture: { output_modalities: ["text"] }, supported_parameters: [], context_length: 1000 },
    { id: "acme/image:free", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["image"] }, supported_parameters: ["tools"], context_length: 1000 },
    { id: "acme/noctx:free", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] },
    { id: "acme/request:free", pricing: { prompt: "0", completion: "0", request: "0.01" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"], context_length: 1000 },
    { id: "acme/dup:free", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"], context_length: 1000 },
    { id: "acme/dup:free", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"], context_length: 1000 },
    { id: "acme/paid-model", pricing: { prompt: "0.1", completion: "0.2" } },
    { id: "nvidia/nemotron-3.5-super-vl:free", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"], context_length: 262_144, reasoning: { mandatory: true } },
  ],
};
const discoveryBody = {
  models: [
    { id: "meta-llama/llama-4-maverick:free", name: "Maverick (claimed)", provider: "Meta", context_window: 1_000_000, source: "https://openrouter.ai/meta-llama", modalities: ["text"], rate_limit: "20/min" },
    { id: "elsewhere/model:free", name: "Elsewhere", source: "https://pollinations.ai/x" },
    { id: "bad/source:free", source: "https://evil.example/x" },
    { id: "bad id", source: "https://openrouter.ai/x" },
  ],
};
const live = parseFreeOpenRouterModels(openRouterBody);
const discovery = parseFreeDiscovery(discoveryBody);
const freeCatalog = { openRouterBody, discoveryBody, live, discovery, merged: mergeFreeCatalog(live, discovery, 1_700_000_000_000, ["w"]) };

const keyInfo = [
  { data: { label: "my\u0001key", limit: 10, limit_remaining: 4.5, usage: 5.5, is_free_tier: true, free_model_daily_requests: { used: 3, limit: 50 } } },
  { data: { limit: null, usage: -1, free_model_daily_requests: { remaining: 7 } } },
  { data: [] }, {}, null,
].map((body) => ({ body, info: parseOpenRouterKeyInfo(body) ?? null }));
const keyFailures = (["invalid", "network", "error"] as const).flatMap((reason) => [undefined, 500].map((status) =>
  ({ reason, status, text: describeKeyCheckFailure({ ok: false, reason, ...(status ? { status } : {}) }) })));

write("internal/core/llm", "catalog.json", { asOf, known, prices, models, envs, endpoints, listings, freeCatalog, keyInfo, keyFailures });

// ---- the server: setup, providers, connect, the model list -----------------------------------

const strip = <T extends { id?: string; provider?: string }>(rows: T[]) => rows.filter((row) => (row.id ?? row.provider) !== "archymedes-cloud");

const setupEnvs: Record<string, Record<string, string>> = {
  none: {},
  groq: { GROQ_API_KEY: "gsk_secret_value_1234" },
  openrouter: { OPENROUTER_API_KEY: "sk-or-v1-abcdef123456", ARCHYMEDES_PROVIDER: "free", FREE_MODEL: "a/b:free" },
  gateway: { ARCHYMEDES_FREE_GATEWAY_URL: "https://gw.example/" },
  badGateway: { ARCHYMEDES_FREE_GATEWAY_URL: "http://gw.example" },
  compat: { OPENAI_COMPATIBLE_API_KEY: "k", OPENAI_COMPATIBLE_BASE_URL: "https://c.example/v1", OPENAI_MODEL: "gpt-x", ARCHYMEDES_PROVIDER: "OpenAI" },
  short: { OPENAI_API_KEY: "short", ANTHROPIC_API_KEY: "sk-ant-api03-0123456789", ANTHROPIC_BASE_URL: "https://a.example" },
};
const setup = Object.entries(setupEnvs).map(([name, env]) => ({
  env: name, values: env,
  providers: strip(setupStatus(env).providers),
  overview: strip(providerOverview(env)),
}));

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
/** A provider endpoint: models for a good key (or no key needed), 401 otherwise; "down" throws. */
const endpoint = (good: string, models: string[] = ["gpt-a", "gpt-b"]): Fetch => async (url, init) => {
  if (url.includes("down.example")) throw new Error("ECONNREFUSED");
  const auth = init?.headers?.authorization ?? init?.headers?.["x-api-key"];
  const ok = auth === undefined || auth === `Bearer ${good}` || auth === good;
  if (url.includes("empty.example")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
  return { ok, status: ok ? 200 : 401, json: async () => ({ data: models.map((id) => ({ id })) }) };
};
const checks = { valid: { ok: true, info: {} }, invalid: { ok: false, reason: "invalid", status: 401 }, network: { ok: false, reason: "network" } } as const;

async function capture<T>(run: (deps: { environment: Record<string, string | undefined>; processEnvironment: Record<string, string | undefined>; load: () => Promise<Record<string, string>>; save: (s: Record<string, string>) => Promise<string> }) => Promise<T>, stored: Record<string, string>) {
  let saved: Record<string, string> | undefined;
  const environment: Record<string, string | undefined> = { ...stored };
  const result = await run({ environment, processEnvironment: {}, load: async () => ({ ...stored }), save: async (s) => { saved = { ...s }; return "/settings.json"; } });
  return { result, saved: saved ?? null };
}

const saveCases: Array<{ params: Record<string, unknown>; stored: Record<string, string>; check?: keyof typeof checks }> = [
  { params: { provider: "groq", key: " gsk_new " }, stored: { OPENAI_API_KEY: "x" } },
  { params: { provider: "free", key: "sk-or-v1-good" }, stored: {}, check: "valid" },
  { params: { provider: "openrouter", key: "sk-or-v1-bad" }, stored: {}, check: "invalid" },
  { params: { provider: "free", key: "sk-or-v1-offline" }, stored: {}, check: "network" },
  { params: { provider: "groq", key: "" }, stored: {} },
  { params: { provider: "groq", key: "has space" }, stored: {} },
  { params: { provider: "nope", key: "k" }, stored: {} },
  { params: { provider: "ollama", key: "k" }, stored: {} },
  { params: { provider: "openai-compatible", key: "k" }, stored: {} },
  { params: {}, stored: {} },
];
const save = [];
for (const c of saveCases) {
  save.push({ ...c, ...(await capture((deps) => saveSetup(c.params, { ...deps, checkOpenRouter: async () => checks[c.check ?? "valid"] as never }), c.stored)) });
}

const connectCases: Array<{ params: Record<string, unknown>; stored: Record<string, string>; good: string; check?: keyof typeof checks }> = [
  { params: { provider: "openai", values: { OPENAI_API_KEY: "sk-good" } }, stored: {}, good: "sk-good" },
  { params: { provider: "openai", values: { OPENAI_API_KEY: "sk-bad" } }, stored: {}, good: "sk-good" },
  { params: { provider: "openai", values: { OPENAI_API_KEY: "", OPENAI_BASE_URL: "" } }, stored: { OPENAI_API_KEY: "sk-good", OPENAI_BASE_URL: "https://p.example/v1" }, good: "sk-good" },
  { params: { provider: "openai", values: { OPENAI_BASE_URL: "https://proxy.example/v1" } }, stored: { OPENAI_API_KEY: "sk-good" }, good: "sk-good" },
  { params: { provider: "openai-compatible", values: { OPENAI_COMPATIBLE_API_KEY: "k" } }, stored: {}, good: "k" },
  { params: { provider: "openai-compatible", values: { OPENAI_COMPATIBLE_API_KEY: "k", OPENAI_COMPATIBLE_BASE_URL: "not a url" } }, stored: {}, good: "k" },
  { params: { provider: "ollama", values: { OLLAMA_BASE_URL: "http://down.example:9/v1" } }, stored: {}, good: "" },
  { params: { provider: "ollama", values: { OLLAMA_BASE_URL: "http://empty.example/v1" } }, stored: {}, good: "" },
  { params: { provider: "openrouter", values: { OPENROUTER_API_KEY: "sk-or-bad" } }, stored: {}, good: "x", check: "invalid" },
  { params: { provider: "openrouter", values: { OPENROUTER_API_KEY: "sk-or-ok" } }, stored: {}, good: "sk-or-ok", check: "network" },
  { params: { provider: "anthropic", values: { ANTHROPIC_API_KEY: "sk-ant-good" } }, stored: {}, good: "sk-ant-good" },
  { params: { provider: "groq", values: { GROQ_API_KEY: 5 } }, stored: {}, good: "x" },
  { params: { provider: "nope" }, stored: {}, good: "" },
  { params: { provider: "groq" }, stored: {}, good: "" },
];
const connect = [];
for (const c of connectCases) {
  const asked: string[] = [];
  const base = endpoint(c.good);
  const fetchImpl: Fetch = async (url, init) => { asked.push(url); return base(url, init); };
  const captured = await capture((deps) => connectProvider(c.params, { ...deps, fetchImpl: fetchImpl as never, checkOpenRouter: async () => checks[c.check ?? "valid"] as never }), c.stored);
  connect.push({ ...c, ...captured, asked });
}

const remember = [];
for (const params of [{ provider: "openai", model: " gpt-b " }, { provider: "free", model: "paid/model" }, { provider: "free", model: "a/b:free" }, { provider: "nope", model: "x" }, { provider: "groq", model: "" }, { provider: "archymedes-cloud", model: "auto" }]) {
  remember.push({ params, ...(await capture((deps) => rememberModel(params, deps), {})) });
}

const providerModelCases = [];
for (const [provider, env] of [["openai", { OPENAI_API_KEY: "sk-good" }], ["openai", { OPENAI_API_KEY: "sk-bad" }], ["openai", {}], ["nope", {}], ["ollama", { OLLAMA_BASE_URL: "http://down.example/v1" }]] as const) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "friday-port-"));
  providerModelCases.push({ provider, env, result: await providerModels({ provider }, { environment: { ...env, ARCHYMEDES_CONFIG_DIR: dir }, fetchImpl: endpoint("sk-good", ["gpt-z", "text-embedding-3-small"]) as never }) });
}

const listingFetch = (asked: string[]): Fetch => async (url) => {
  asked.push(url);
  if (url.startsWith("https://openrouter.ai/api/v1/models")) return { ok: true, status: 200, json: async () => openRouterBody };
  if (url.includes("api.anthropic.com")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude-new-model" }, { id: "claude-sonnet-5" }, { id: "claude-embed-x" }] }) };
  if (url.includes("api.groq.com")) return { ok: false, status: 500, json: async () => ({}) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const listCases: Array<{ name: string; env: Record<string, string>; params: Record<string, unknown> }> = [
  { name: "anthropic", env: { ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_MODEL: "claude-opus-5" }, params: {} },
  { name: "nothing", env: {}, params: {} },
  { name: "offline", env: { ARCHYMEDES_MODELS_OFFLINE: "1", GROQ_API_KEY: "q" }, params: {} },
  { name: "groq-refresh", env: { GROQ_API_KEY: "q", OPENROUTER_API_KEY: "sk-or" }, params: { refresh: true } },
];
const list = [];
for (const c of listCases) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "friday-port-"));
  const asked: string[] = [];
  const result = await modelList({ ...c.env, ARCHYMEDES_CONFIG_DIR: dir }, c.params, { fetchImpl: listingFetch(asked) as never });
  list.push({ ...c, asked: asked.map((url) => url.replace(/\?.*/, "")).sort(), choices: strip(result.choices), unconfigured: strip(result.unconfigured), errors: result.errors });
}

write("internal/core/server", "providers.json", { setup, save, connect, remember, providerModels: providerModelCases, list });
console.log(`catalog: ${prices.length} prices, ${models.length} ids, ${endpoints.length} endpoints; server: ${setup.length} setups, ${save.length} saves, ${connect.length} connects, ${list.length} lists`);
