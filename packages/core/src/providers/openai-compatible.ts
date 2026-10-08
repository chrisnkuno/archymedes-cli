import type { AgentImage, AgentMessage, AgentModelTurn, AgentOutputKind } from "../agent-runtime";
import type { ModelUsage } from "./model";
import { parseRoutingReceipt } from "./routing-receipt";

/**
 * The Chat Completions wire format, shared by every OpenAI-compatible provider.
 *
 * CircuitNotion and OpenAI speak the same protocol; only the endpoint and headers differ. Keeping
 * one translation means a tool-call parsing fix lands for both, instead of being fixed in the
 * adapter someone happened to be debugging.
 */

export type ChatResponse = {
  id: string;
  model: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      content: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
  /** Present only from the hosted exchange: the routing decision for this completion. */
  archymedes?: { routing_receipt?: unknown; usage_event?: unknown };
};

export function usageOf(response: ChatResponse): ModelUsage {
  if (!response.usage) throw new Error("Model response did not include usage accounting");
  const usage = {
    inputTokens: response.usage.prompt_tokens,
    outputTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens,
    cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: response.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: response.usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  if (Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Model response contained invalid usage accounting");
  return usage;
}

export function toWireMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId, name: message.name };
  if (message.role === "assistant" && "toolCalls" in message) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
    };
  }
  if (message.role === "user" && "images" in message && message.images?.length) {
    return {
      role: "user",
      content: [
        { type: "text", text: message.content },
        ...message.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
      ],
    };
  }
  return { role: message.role, content: message.content };
}

export type WireMessageOptions = {
  /**
   * Whether the model can see images. Default true, matching how user-attached images have always
   * been sent. False turns tool-returned images into a text note instead of an image part.
   */
  vision?: boolean;
};

/**
 * The runtime's messages as Chat Completions messages.
 *
 * A `tool` message there can only carry text, so images a tool returned (view_image) travel in one
 * follow-up `user` message placed right after that step's run of tool messages — after the run, not
 * between its members, because every tool_call_id must be answered before anything else is said.
 */
export function toWireMessages(messages: readonly AgentMessage[], options: WireMessageOptions = {}): Array<Record<string, unknown>> {
  const vision = options.vision ?? true;
  const wire: Array<Record<string, unknown>> = [];
  let pending: Array<{ name: string; images: AgentImage[] }> = [];
  const flush = () => {
    if (pending.length === 0) return;
    wire.push({
      role: "user",
      content: [
        { type: "text", text: `Image${pending.reduce((sum, entry) => sum + entry.images.length, 0) === 1 ? "" : "s"} returned by the ${[...new Set(pending.map((entry) => entry.name))].join(", ")} tool call${pending.length === 1 ? "" : "s"} above: ${pending.flatMap((entry) => entry.images.map((image) => image.path)).join(", ")}` },
        ...pending.flatMap((entry) => entry.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } }))),
      ],
    });
    pending = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") flush();
    if (message.role === "tool" && message.images?.length) {
      if (vision) {
        wire.push(toWireMessage(message));
        pending.push({ name: message.name, images: message.images });
      } else {
        const note = `[${message.images.length === 1 ? "image" : "images"} not shown: this model cannot view images (${message.images.map((image) => image.path).join(", ")})]`;
        wire.push(toWireMessage({ ...message, content: `${message.content}
${note}` }));
      }
      continue;
    }
    wire.push(toWireMessage(message));
  }
  flush();
  return wire;
}

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * Whether an OpenRouter model honours explicit `cache_control` breakpoints.
 *
 * OpenAI, DeepSeek, Grok and most others cache a stable prefix automatically and need nothing; the
 * Anthropic and Gemini families on OpenRouter only cache where the request marks a breakpoint.
 */
export function usesOpenRouterCacheControl(model: string): boolean {
  return model.startsWith("anthropic/") || model.startsWith("google/");
}

/** Whether a base URL is OpenRouter's, where `cache_control` on message parts is accepted. */
export function isOpenRouterBaseUrl(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try { return new URL(baseURL).hostname.endsWith("openrouter.ai"); } catch { return false; }
}

function withPartBreakpoint(message: Record<string, unknown>): Record<string, unknown> {
  if (typeof message.content === "string") {
    return message.content ? { ...message, content: [{ type: "text", text: message.content, cache_control: EPHEMERAL }] } : message;
  }
  if (!Array.isArray(message.content)) return message;
  const parts = message.content as Array<Record<string, unknown>>;
  const last = parts.map((part) => part.type).lastIndexOf("text");
  if (last < 0) return message;
  return { ...message, content: parts.map((part, index) => (index === last ? { ...part, cache_control: EPHEMERAL } : part)) };
}

/**
 * Adds OpenRouter `cache_control` breakpoints for models that need them (see
 * `usesOpenRouterCacheControl`): one on the system message, covering tools plus the fixed system
 * prompt, and one on the last user message, covering the conversation up to it. Two of the four
 * breakpoints Anthropic allows; Gemini uses only the last. Other models get the messages unchanged.
 */
export function withOpenRouterCacheControl(messages: Array<Record<string, unknown>>, model: string): Array<Record<string, unknown>> {
  if (!usesOpenRouterCacheControl(model)) return messages;
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  return messages.map((message, index) => (message.role === "system" || index === lastUser ? withPartBreakpoint(message) : message));
}

function parseArguments(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * The wire's `finish_reason` as one of the four the runtime understands.
 *
 * Every provider spells these slightly differently, and the spellings are not interchangeable in
 * the direction that matters: `length` means *the model was not finished*, and reading it as a
 * normal stop would silently hand a half-written answer to the caller as a complete one.
 *
 * `undefined` means genuinely unrecognised, which stays an error — inventing a reading for a word
 * nobody has seen is how truncation gets mistaken for completion.
 */
function readFinishReason(reason: string | null): AgentModelTurn["finishReason"] | undefined {
  switch (reason) {
    case "stop":
    case "end_turn":
      return "stop";
    case "tool_calls":
    case "function_call":
    case "tool_use":
      return "tool_calls";
    // The output budget ran out. OpenAI and OpenAI-compatible gateways say "length";
    // `max_tokens` / `model_length` are the same event under other gateways' names.
    case "length":
    case "max_tokens":
    case "model_length":
      return "length";
    case "content_filter":
      return "refusal";
    default:
      return undefined;
  }
}

/** Reads one Chat Completions response into the runtime's turn shape. */
export function turnFromChatResponse(response: ChatResponse): AgentModelTurn {
  const choice = response.choices[0];
  if (!choice) throw new Error("Model response contained no choices");
  const toolCalls = (choice.message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: parseArguments(call.function.arguments) }));
  // `null` is not an unknown word — it is no word at all, which several gateways send when the
  // final chunk carrying the reason never arrives (or is dropped by a proxy) even though the
  // content and tool calls came through intact. Erroring on it threw away a complete, usable turn
  // and ended the user's request with "Unsupported model finish reason: null". Unstated is read
  // from the payload instead: calls mean a tool turn, text means a finished one, and nothing at
  // all still errors, because a turn with no reason *and* no output carries no answer to give.
  const inferred = choice.finish_reason === null || choice.finish_reason === undefined
    ? (toolCalls.length > 0 ? "tool_calls" : choice.message.content ? "stop" : undefined)
    : readFinishReason(choice.finish_reason);
  const read = choice.message.refusal ? "refusal" : inferred;
  // An unrecognised *word* stays an error: inventing a reading for a spelling nobody has seen is
  // how truncation gets mistaken for completion.
  if (!read) throw new Error(`Unsupported model finish reason: ${choice.finish_reason}`);
  // Some gateways report a tool-call turn as a plain "stop". Trusting the reason over the payload
  // there drops the calls on the floor and answers with an empty message instead of running them.
  const finishReason = read === "stop" && toolCalls.length > 0 ? "tool_calls" : read;
  const refusal = choice.message.refusal
    ?? (finishReason === "refusal" ? "The provider's content filter stopped this response." : undefined);
  const routingReceipt = parseRoutingReceipt(response.archymedes?.routing_receipt);
  return {
    responseId: response.id,
    model: response.model,
    finishReason,
    content: choice.message.content ?? "",
    refusal: refusal ?? undefined,
    // A turn cut off at the output cap cannot carry tool calls forward. Whatever arrived was being
    // written when the budget ran out, so its arguments are a truncated JSON fragment; executing a
    // call parsed from one would act on arguments the model never finished choosing. The runtime
    // asks for the call again instead.
    toolCalls: finishReason === "length" || finishReason === "refusal" ? [] : toolCalls,
    usage: usageOf(response),
    ...(routingReceipt ? { routingReceipt } : {}),
  };
}

/** One server-sent chunk of a streamed chat completion. Every field is absent on some chunk. */
export type ChatStreamChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      refusal?: string | null;
      /** Reasoning text, under the names OpenRouter (`reasoning`) and DeepSeek-style gateways use. */
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: ChatResponse["usage"];
};

/**
 * Folds a streamed completion back into the single response shape the adapters already read.
 *
 * Tool calls are the subtle part: they arrive as fragments keyed by `index`, with the name on the
 * first fragment and the JSON arguments dribbling across many. Accumulating by index — rather than
 * by the id, which is absent on later fragments — is what makes a streamed tool call identical to
 * a buffered one by the time the runtime sees it.
 */
export async function collectChatStream(
  stream: AsyncIterable<ChatStreamChunk>,
  onTextDelta?: (text: string) => void,
  /** Reports every piece of model output, including reasoning and tool-call fragments. */
  onOutputProgress?: (kind: AgentOutputKind) => void,
): Promise<ChatResponse> {
  let id = "";
  let model = "";
  let content = "";
  let refusal = "";
  let finishReason: string | null = null;
  let usage: ChatResponse["usage"] = null;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for await (const chunk of stream) {
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.refusal) refusal += choice.delta.refusal;
    if (choice.delta?.reasoning || choice.delta?.reasoning_content) onOutputProgress?.("reasoning");
    if (choice.delta?.content) {
      content += choice.delta.content;
      onOutputProgress?.("text");
      onTextDelta?.(choice.delta.content);
    }
    if (choice.delta?.tool_calls?.length) onOutputProgress?.("tool_call");
    for (const fragment of choice.delta?.tool_calls ?? []) {
      const existing = calls.get(fragment.index) ?? { id: "", name: "", args: "" };
      // Truthiness, not nullish coalescing: providers send `"name": ""` and `"id": null` on the
      // continuation fragments, and `??` treats the empty string as a real value — which silently
      // erased the tool's name and made every streamed call fail as "outside the capability scope".
      calls.set(fragment.index, {
        id: fragment.id || existing.id,
        name: fragment.function?.name || existing.name,
        args: existing.args + (fragment.function?.arguments ?? ""),
      });
    }
  }

  const tool_calls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.args } }));

  return {
    id,
    model,
    choices: [{
      finish_reason: finishReason,
      message: { content: content || null, refusal: refusal || null, ...(tool_calls.length > 0 ? { tool_calls } : {}) },
    }],
    usage,
  };
}
