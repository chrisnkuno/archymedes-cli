/**
 * Which optional Chat Completions fields each vendor accepts.
 *
 * "OpenAI-compatible" means the same message shape, not the same request contract. OpenAI keeps
 * adding fields (`prompt_cache_key`, `safety_identifier`, `max_completion_tokens`), and a vendor
 * that validates strictly answers one it does not know with a 400 for the whole request. Groq did
 * exactly that: "prompt_cache_key is unsupported", on every turn, for every model.
 *
 * So the adapter sends a field only where the vendor's own API reference lists it. Each row
 * records what that reference said on the date given. `chat-dialects.test.ts` checks every
 * provider's real request body against the vendor's documented field list, so a field added to the
 * adapter later cannot reach a vendor that never accepted it without a test failing first.
 */

export type ChatDialect = {
  /** The output-limit field. `max_tokens` is the one every vendor accepts; OpenAI deprecated it for reasoning models. */
  maxTokensField: "max_completion_tokens" | "max_tokens";
  /** OpenAI's cache-routing hint. */
  promptCacheKey: boolean;
  /** OpenAI's abuse-attribution id. */
  safetyIdentifier: boolean;
  /** `tool_choice: "auto"`, which is every vendor's default when tools are present anyway. */
  toolChoice: boolean;
  /** `parallel_tool_calls: true`, sent alongside the tools. */
  parallelToolCalls: boolean;
  /** `stream_options: { include_usage: true }`. Without it OpenAI streams no usage at all. */
  streamOptions: boolean;
};

/** OpenAI itself, and OpenRouter, which forwards OpenAI's fields to whichever upstream it routes to. */
export const OPENAI_DIALECT: ChatDialect = { maxTokensField: "max_completion_tokens", promptCacheKey: true, safetyIdentifier: true, toolChoice: true, parallelToolCalls: true, streamOptions: true };

/**
 * What an endpoint nobody has documented here gets: the fields OpenAI-compatible servers broadly
 * share (vLLM, LM Studio, llama.cpp and LiteLLM all accept these). An unknown endpoint is not a
 * reason to send more.
 */
export const PORTABLE_DIALECT: ChatDialect = { maxTokensField: "max_tokens", promptCacheKey: false, safetyIdentifier: false, toolChoice: true, parallelToolCalls: true, streamOptions: true };

/** Vendor dialects, from each vendor's API reference as read on 2026-10-15. */
export const VENDOR_DIALECTS = {
  // console.groq.com/docs/api-reference: max_tokens deprecated but accepted; no prompt_cache_key or safety_identifier.
  groq: PORTABLE_DIALECT,
  // docs.mistral.ai/api: max_tokens only, no stream_options (usage arrives in the last chunk regardless).
  mistral: { ...PORTABLE_DIALECT, streamOptions: false },
  // api-docs.deepseek.com: max_tokens only; parallel_tool_calls is not a documented field.
  deepseek: { ...PORTABLE_DIALECT, parallelToolCalls: false },
  // ai.google.dev/gemini-api/docs/openai: the compatibility layer, still in beta; parallel_tool_calls is not mentioned.
  google: { ...PORTABLE_DIALECT, parallelToolCalls: false },
  // docs.x.ai now documents only its Responses API; Chat Completions is unverified, so portable.
  xai: PORTABLE_DIALECT,
  // docs.ollama.com/api/openai-compatibility: tool_choice is listed as unsupported, parallel_tool_calls not at all.
  ollama: { ...PORTABLE_DIALECT, toolChoice: false, parallelToolCalls: false },
  "openai-compatible": PORTABLE_DIALECT,
} as const satisfies Record<string, ChatDialect>;

/**
 * The dialect for an endpoint the caller did not name a vendor for: OpenAI's own host (or no base
 * URL, which is OpenAI's default) and OpenRouter get OpenAI's contract; anything else is portable.
 */
export function dialectForBaseUrl(baseURL: string | undefined): ChatDialect {
  if (!baseURL) return OPENAI_DIALECT;
  try {
    const host = new URL(baseURL).hostname;
    return host === "api.openai.com" || host.endsWith("openrouter.ai") ? OPENAI_DIALECT : PORTABLE_DIALECT;
  } catch {
    return PORTABLE_DIALECT;
  }
}
