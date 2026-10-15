import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModelRequest } from "../agent-runtime";
import { PROVIDERS, providerEnvPrefix } from "./agent-matrix";
import { dialectForBaseUrl, OPENAI_DIALECT, PORTABLE_DIALECT } from "./chat-dialects";
import { PROVIDER_IDS, PROVIDER_INFO, type ProviderId } from "./provider-specs";

/**
 * Every provider's real request, checked against what its vendor documents.
 *
 * Each provider is built through the same factory a session uses, and its HTTP request is caught at
 * `fetch`, below the SDK. So this sees the body the vendor would see: whatever the adapter, the
 * dialect table and the SDK add between them. The adapter's own unit tests cannot catch a field
 * that is valid for OpenAI but unknown to Groq; this suite exists for that.
 *
 * The field lists are transcribed from each vendor's API reference, not from the adapter, so the
 * two can disagree. When one does, either the adapter is sending something the vendor never
 * accepted, or the vendor has added a field and this list needs updating, with its source.
 */

const OPENAI_FIELDS = [
  "model", "messages", "tools", "tool_choice", "parallel_tool_calls", "max_completion_tokens", "max_tokens",
  "safety_identifier", "prompt_cache_key", "reasoning_effort", "stream", "stream_options",
];

/** Fields each vendor's API reference lists for chat completions, as read on 2026-10-15. */
const DOCUMENTED_FIELDS: Record<Exclude<ProviderId, "free" | "archymedes-cloud">, readonly string[]> = {
  // platform.openai.com/docs/api-reference/chat/create
  openai: OPENAI_FIELDS,
  // openrouter.ai/docs/api-reference: the OpenAI set, forwarded to the routed upstream.
  openrouter: OPENAI_FIELDS,
  // docs.anthropic.com/en/api/messages
  anthropic: ["model", "max_tokens", "system", "messages", "tools", "tool_choice", "output_config", "metadata", "stream", "thinking"],
  // console.groq.com/docs/api-reference
  groq: ["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "max_completion_tokens", "max_tokens", "reasoning_effort", "stream", "stream_options"],
  // docs.mistral.ai/api: no max_completion_tokens, no stream_options.
  mistral: ["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "max_tokens", "reasoning_effort", "prompt_cache_key", "stream"],
  // api-docs.deepseek.com/api/create-chat-completion: no parallel_tool_calls.
  deepseek: ["model", "messages", "tools", "tool_choice", "max_tokens", "reasoning_effort", "stream", "stream_options"],
  // ai.google.dev/gemini-api/docs/openai
  google: ["model", "messages", "tools", "tool_choice", "max_tokens", "reasoning_effort", "stream", "stream_options"],
  // docs.ollama.com/api/openai-compatibility: tool_choice is listed as unsupported.
  ollama: ["model", "messages", "tools", "max_tokens", "reasoning_effort", "stream", "stream_options"],
  // No current Chat Completions reference from xAI; held to the portable set.
  xai: ["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "max_tokens", "reasoning_effort", "stream", "stream_options"],
  // An arbitrary gateway: the portable set and nothing more.
  "openai-compatible": ["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "max_tokens", "reasoning_effort", "stream", "stream_options"],
};

/** Providers whose request is a contract with Archymedes' own gateway, tested in their own suites. */
const GATEWAY_OWNED: readonly ProviderId[] = ["free", "archymedes-cloud"];

const BASE_URLS: Partial<Record<ProviderId, string>> = { "openai-compatible": "https://gateway.example/v1" };

const request: AgentModelRequest = {
  messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
  maxOutputTokens: 1_024,
  safetyIdentifier: "archymedes_cli_contract",
  effort: "high",
};

function sse(events: unknown[], done: boolean): Response {
  // Anthropic's stream names each event; OpenAI's does not, and an `event:` line it ignores.
  const text = events.map((event) => `${done ? "" : `event: ${(event as { type: string }).type}\n`}data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const chatStream = () => sse([
  { id: "c", model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
  { id: "c", model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
], true);

const anthropicStream = () => sse([
  { type: "message_start", message: { id: "m", model: "claude", usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
], false);

type Captured = { url: string; body: Record<string, unknown> };

async function capture(id: ProviderId, model = PROVIDER_INFO[id].defaultModel, extra: Partial<AgentModelRequest> = {}): Promise<Captured> {
  const seen: Captured[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return id === "anthropic" ? anthropicStream() : chatStream();
  });
  const prefix = providerEnvPrefix(id);
  const environment = { [`${prefix}_API_KEY`]: "test-key", ...(BASE_URLS[id] ? { [`${prefix}_BASE_URL`]: BASE_URLS[id] } : {}) };
  const turn = await PROVIDERS[id].create(environment, model).complete({ ...request, ...extra });
  expect(turn.content).toBe("ok");
  expect(seen).toHaveLength(1);
  return seen[0];
}

const COVERED = PROVIDER_IDS.filter((id): id is keyof typeof DOCUMENTED_FIELDS => !GATEWAY_OWNED.includes(id));

describe("provider wire contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("covers every provider, so a new one cannot ship without a documented field list", () => {
    for (const id of PROVIDER_IDS) expect(id in DOCUMENTED_FIELDS || GATEWAY_OWNED.includes(id), id).toBe(true);
  });

  it.each(COVERED)("%s receives only fields its API reference documents", async (id) => {
    const { body } = await capture(id);
    const undocumented = Object.keys(body).filter((field) => !DOCUMENTED_FIELDS[id].includes(field));
    expect(undocumented).toEqual([]);
  });

  it.each(COVERED)("%s still receives the fields a turn needs", async (id) => {
    const { body } = await capture(id);
    expect(body.model).toBe(PROVIDER_INFO[id].defaultModel);
    expect(body.stream).toBe(true);
    expect(body.messages).toBeDefined();
    expect(body.tools).toHaveLength(1);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(request.maxOutputTokens);
  });

  it.each(COVERED)("%s gets a request without tools that is still within its contract", async (id) => {
    const { body } = await capture(id, undefined, { tools: [] });
    expect(Object.keys(body).filter((field) => !DOCUMENTED_FIELDS[id].includes(field))).toEqual([]);
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  it("sends Groq's own models to Groq's host", async () => {
    const { url } = await capture("groq");
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("keeps OpenAI's caching and attribution fields where OpenAI reads them", async () => {
    for (const id of ["openai", "openrouter"] as const) {
      const { body } = await capture(id);
      expect(body.prompt_cache_key, id).toBe(request.safetyIdentifier);
      expect(body.safety_identifier, id).toBe(request.safetyIdentifier);
    }
  });
});

describe("dialect for an unnamed endpoint", () => {
  it("gives OpenAI's contract only to OpenAI and OpenRouter", () => {
    expect(dialectForBaseUrl(undefined)).toBe(OPENAI_DIALECT);
    expect(dialectForBaseUrl("https://api.openai.com/v1")).toBe(OPENAI_DIALECT);
    expect(dialectForBaseUrl("https://openrouter.ai/api/v1")).toBe(OPENAI_DIALECT);
    expect(dialectForBaseUrl("https://api.groq.com/openai/v1")).toBe(PORTABLE_DIALECT);
    expect(dialectForBaseUrl("https://api.openai.com.evil.example/v1")).toBe(PORTABLE_DIALECT);
    expect(dialectForBaseUrl("not a url")).toBe(PORTABLE_DIALECT);
  });
});
