import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { OpenAIAgentTurnProvider, type OpenAIChatCall } from "./openai-agent";
import { capabilitiesFor, type ModelCapabilities } from "./model-capabilities";
import type { StreamTimeouts } from "./stream-fetch";

/**
 * Direct OpenRouter provider: the user's own key against OpenRouter's API, for any model.
 *
 * This is the sibling of `free-agent.ts`, and the difference is the whole point. Free mode pins
 * the fixed host, forces `max_price: 0` with fallbacks off, and rejects anything that is not a
 * verified `:free` tool model. This provider sends the model id as given — paid or free,
 * `openrouter/auto` included — and lets OpenRouter route (and fall back) as it normally does.
 *
 * A thin wrapper over `OpenAIAgentTurnProvider` rather than a second copy of it: OpenRouter
 * speaks the same Chat Completions protocol, so the only differences are the default host and
 * the optional attribution headers (`HTTP-Referer`, `X-Title`) that let an app appear on the
 * OpenRouter leaderboards. A wire-level fix in the shared adapter lands here without a second
 * copy to remember. The wrapper adds identity (its own key/model validation and `selection`),
 * its own error hints, and nothing else.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenRouterAgentOptions = {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Optional site URL for OpenRouter rankings. Sent as `HTTP-Referer`. */
  httpReferer?: string;
  /** Optional site title for OpenRouter rankings. Sent as `X-Title`. */
  appTitle?: string;
  timeoutMs?: number;
  /** TTFB/idle/total budget for the stream, forwarded to the shared adapter. */
  streamTimeouts?: StreamTimeouts;
};

export class OpenRouterAgentTurnProvider implements AgentTurnProvider {
  private readonly inner: OpenAIAgentTurnProvider;
  /** What this model can hold and produce, so the session sizes its budgets from the model. */
  readonly capabilities: ModelCapabilities;
  readonly selection: { provider: string; model: string };

  constructor(private readonly options: OpenRouterAgentOptions, call?: OpenAIChatCall) {
    if (!options.apiKey.trim()) throw new Error("OPENROUTER_API_KEY is required");
    if (!options.model.trim()) throw new Error("OPENROUTER_MODEL is required");
    this.selection = { provider: "openrouter", model: options.model };
    this.capabilities = capabilitiesFor(options.model);
    this.inner = new OpenAIAgentTurnProvider({
      apiKey: options.apiKey,
      model: options.model,
      baseURL: options.baseURL?.trim() || OPENROUTER_BASE_URL,
      // Attribution only; never a credential. Lets the app appear on OpenRouter rankings.
      defaultHeaders: {
        ...(options.httpReferer?.trim() ? { "HTTP-Referer": options.httpReferer.trim() } : {}),
        "X-Title": options.appTitle?.trim() || "Archymedes CLI",
      },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.streamTimeouts !== undefined ? { streamTimeouts: options.streamTimeouts } : {}),
    }, call);
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    try {
      return await this.inner.complete(request);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw withHint(error);
    }
  }
}

function withHint(error: unknown): Error {
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
  if (status === undefined) return error instanceof Error ? error : new Error(String(error));
  const hint = status === 401 ? "OpenRouter rejected the key. Update OPENROUTER_API_KEY in archymedes settings."
    : status === 402 ? "OpenRouter account quota or key budget is exhausted. Check the key limits."
    : status === 403 ? "OpenRouter refused this model for this key. Choose another with /model."
    : status === 429 ? "OpenRouter rate limit reached. Wait before retrying."
    : status === 404 ? "This OpenRouter model is unavailable. Run /models refresh."
    : `OpenRouter request failed (HTTP ${status}).`;
  const wrapped = new Error(hint);
  (wrapped as { status?: number }).status = status;
  (wrapped as { cause?: unknown }).cause = error;
  return wrapped;
}
