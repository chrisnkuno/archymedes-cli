import OpenAI from "openai";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { collectChatStream, isOpenRouterBaseUrl, toWireMessages, turnFromChatResponse, withOpenRouterCacheControl, type ChatResponse, type ChatStreamChunk } from "./openai-compatible";
import { capabilitiesFor, type ModelCapabilities } from "./model-capabilities";
import { withStreamDeadline, type StreamTimeouts as DeadlineTimeouts } from "./stream-deadline";
import { fetchWithStreamTimeouts, resolveStreamTimeouts, type StreamTimeouts } from "./stream-fetch";

/**
 * OpenAI adapter for the agent loop.
 *
 * Shares its wire handling with the CircuitNotion adapter through `openai-compatible`, because they
 * speak the same Chat Completions protocol — the difference is the endpoint and the headers, not
 * the message shape. Two copies of that translation is two places for a tool-call bug to hide.
 */

export type OpenAIAgentOptions = {
  apiKey: string; model: string; baseURL?: string; defaultHeaders?: Record<string, string>;
  /**
   * The stream's *idle* timeout (longest silence between chunks), not a wall-clock limit on the
   * whole reply; see `streamTimeoutsFor` for how it maps onto the first-byte and overall deadlines.
   */
  timeoutMs?: number;
  /** Underlying fetch, wrapped with byte-level stream timeouts. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** TTFB/idle/total budget for the stream; overrides what `timeoutMs` implies. */
  streamTimeouts?: StreamTimeouts;
};

export type OpenAIChatCall = (body: Record<string, unknown>, signal: AbortSignal) => Promise<ChatResponse | AsyncIterable<ChatStreamChunk>>;

type ChatCall = OpenAIChatCall;

function usesInklingToolContract(model: string): boolean {
  return model === "thinkingmachines/inkling:free" || model === "thinkingmachines/inkling-small:free";
}

export class OpenAIAgentTurnProvider implements AgentTurnProvider {
  private readonly call: ChatCall;
  /** True when the transport was injected, so the deadline is applied at the call boundary. */
  private readonly injected: boolean;
  /** The stream's first-byte, idle and total deadlines. */
  private readonly timeouts: DeadlineTimeouts;
  /** What this model can hold and produce, so the session sizes its budgets from the model. */
  readonly capabilities: ModelCapabilities;

  constructor(private readonly options: OpenAIAgentOptions, call?: ChatCall) {
    if (!options.apiKey.trim()) throw new Error("OPENAI_API_KEY is required");
    if (!options.model.trim()) throw new Error("OPENAI_MODEL is required");
    this.capabilities = capabilitiesFor(options.model);
    this.timeouts = resolveStreamTimeouts(options.timeoutMs, options.streamTimeouts);
    this.injected = Boolean(call);
    if (call) this.call = call;
    else {
      // Retry policy is centralized in BoundedAgentRuntime so attempt counts, cancellation and
      // messages stay truthful instead of being multiplied invisibly by the SDK. Timeouts are
      // byte-level (time-to-first-byte, silence between chunks, total) rather than one wall-clock
      // timer over the whole stream, so a slow-but-alive response is never mistaken for a stuck
      // one and killed mid-sentence. The SDK's own timeout sits a minute past the total so the
      // descriptive byte-level error always wins the race.
      const { firstByteMs, idleMs, totalMs } = this.timeouts;
      const streamFetch = fetchWithStreamTimeouts(options.fetchImpl ?? globalThis.fetch, { ttfbMs: firstByteMs, idleMs, totalMs });
      const client = new OpenAI({ apiKey: options.apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}), ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}), maxRetries: 0, timeout: totalMs + 60_000, fetch: streamFetch });
      this.call = async (body, signal) => (await client.chat.completions.create(body as never, { signal })) as unknown as ChatResponse | AsyncIterable<ChatStreamChunk>;
    }
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    if (!request.safetyIdentifier.trim()) throw new Error("safetyIdentifier is required");
    const inkling = usesInklingToolContract(this.options.model);
    const body = {
      model: this.options.model,
      // OpenAI caches a stable prefix on its own; through OpenRouter, the Anthropic and Gemini
      // families only cache where a `cache_control` breakpoint says so.
      messages: isOpenRouterBaseUrl(this.options.baseURL)
        ? withOpenRouterCacheControl(toWireMessages(request.messages), this.options.model)
        : toWireMessages(request.messages),
      ...(request.tools.length > 0 ? {
        tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      } : {}),
      // Inkling's OpenRouter endpoint advertises tools, but not tool_choice or parallel tool
      // calls, and it accepts max_tokens rather than max_completion_tokens. Sending the broader
      // OpenAI contract makes the request fail before Inkling can call a single tool.
      ...(inkling || request.tools.length === 0 ? {} : { tool_choice: "auto", parallel_tool_calls: true }),
      ...(inkling
        ? { max_tokens: request.maxOutputTokens }
        : { max_completion_tokens: request.maxOutputTokens }),
      safety_identifier: request.safetyIdentifier,
      // The documented routing hint for prompt caching, and the replacement for the deprecated
      // `user` field. Stable for the whole session, which is what makes it useful: cached prefixes
      // are routed by this key, and a per-request value would scatter them across shards and hit
      // nothing. The sibling CircuitNotion adapter has always sent one; this path had not.
      prompt_cache_key: request.safetyIdentifier,
      // Effort is only sent when the caller asked for one and the model accepts the field.
      // Reasoning tokens bill as output and share the output budget, so this is a direct spend
      // control, not a quality preference.
      ...(request.effort && this.capabilities.supportsEffort ? { reasoning_effort: request.effort } : {}),
      // Streaming is unconditional. `max_completion_tokens` is now sized from what the model can
      // really write, and an unstreamed reply that large risks the SDK's HTTP timeout — the call is
      // billed and the answer lost. `include_usage` travels with it because on Chat Completions a
      // streamed response reports no usage without it, and the accounting is not optional.
      stream: true,
      stream_options: { include_usage: true },
    };
    // One deadline per request, enforced in one place: by the byte-level fetch wrapper when this
    // adapter built the SDK client (SSE keepalives count as life there), or here, over the parsed
    // chunks, when the transport was injected. Either way a long, healthy generation is never cut
    // off mid-answer, while a stalled connection still fails promptly.
    if (!this.injected) {
      // Cancellation comes from the caller alone; liveness is the fetch wrapper's job.
      const response = await this.call(body, request.signal ?? AbortSignal.any([]));
      return turnFromChatResponse(
        Symbol.asyncIterator in Object(response)
          ? await collectChatStream(response as AsyncIterable<ChatStreamChunk>, request.onTextDelta, request.onOutputProgress)
          : (response as ChatResponse),
      );
    }
    return await withStreamDeadline(this.timeouts, request.signal, async (deadline) => {
      const response = await deadline.race(this.call(body, deadline.signal));
      return turnFromChatResponse(
        Symbol.asyncIterator in Object(response)
          ? await collectChatStream(deadline.wrap(response as AsyncIterable<ChatStreamChunk>), request.onTextDelta, request.onOutputProgress)
          : (response as ChatResponse),
      );
    });
  }
}
