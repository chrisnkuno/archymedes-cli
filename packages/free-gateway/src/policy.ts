/**
 * What a shared free key may be asked to do. The gateway rebuilds every request from an allowlist
 * instead of forwarding the client's body, so a client cannot choose a paid model, override the
 * zero price cap, enable fallbacks or plugins, or ask for unbounded output on the operator's account.
 */
import { isFreeModelId, type FreeModel } from "@archymedes/core/providers/free-catalog";

export type GatewayLimits = {
  maxBodyBytes: number;
  maxMessages: number;
  maxTools: number;
  maxOutputTokens: number;
};

export const DEFAULT_LIMITS: GatewayLimits = {
  maxBodyBytes: 2 * 1024 * 1024,
  maxMessages: 400,
  maxTools: 64,
  maxOutputTokens: 8_192,
};

export type PolicyResult = { body: Record<string, unknown> } | { status: number; message: string };

const ROLES = new Set(["system", "user", "assistant", "tool"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTool(tool: unknown): boolean {
  if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) return false;
  const name = tool.function.name;
  return typeof name === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(name)
    && (tool.function.parameters === undefined || isRecord(tool.function.parameters));
}

export function sanitizeChatRequest(raw: unknown, eligible: ReadonlyMap<string, FreeModel>, limits: GatewayLimits = DEFAULT_LIMITS): PolicyResult {
  if (!isRecord(raw)) return { status: 400, message: "Request body must be a JSON object." };
  const model = typeof raw.model === "string" ? eligible.get(raw.model) : undefined;
  if (!model || !model.eligible || !isFreeModelId(model.id)) {
    return { status: 400, message: "This gateway serves only verified free tool models listed at /v1/models." };
  }
  const messages = raw.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > limits.maxMessages
    || !messages.every((message) => isRecord(message) && typeof message.role === "string" && ROLES.has(message.role))) {
    return { status: 400, message: `messages must be 1-${limits.maxMessages} chat messages.` };
  }
  const tools = raw.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.length > limits.maxTools || !tools.every(validTool))) {
    return { status: 400, message: `tools must be at most ${limits.maxTools} function definitions.` };
  }
  const requested = raw.max_tokens;
  const ceiling = Math.min(limits.maxOutputTokens, model.max_output ?? 4_096);
  const maxTokens = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, ceiling) : ceiling;
  const stream = raw.stream === true;
  return {
    body: {
      model: model.id,
      messages,
      ...(Array.isArray(tools) && tools.length ? { tools } : {}),
      max_tokens: maxTokens,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      provider: { require_parameters: true, max_price: { prompt: 0, completion: 0 }, allow_fallbacks: false },
    },
  };
}
