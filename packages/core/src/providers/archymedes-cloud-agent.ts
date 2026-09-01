import { randomUUID } from "node:crypto";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { toWireMessages, turnFromChatResponse, type ChatResponse } from "./openai-compatible";
import { capabilitiesFor, type ModelCapabilities } from "./model-capabilities";

export type ArchymedesCloudDataPolicy = "standard" | "no-training" | "zero-retention" | "local-only";

export type ArchymedesCloudAgentOptions = {
  token: string;
  baseURL: string;
  model?: string;
  maximumMicros?: number;
  currency?: string;
  region?: string;
  dataPolicy?: string;
  qualityFloor?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** An HTTP failure whose status remains visible to the runtime's bounded retry policy. */
export class ArchymedesCloudError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "ArchymedesCloudError";
  }
}

/**
 * CLI adapter for the hosted execution exchange.
 *
 * Every model call carries a hard reservation cap. The exchange owns routing, provider credentials,
 * normalized usage, settlement and the auditable receipt; the CLI only receives the compatible
 * completion. This deliberately uses a buffered response until the exchange exposes a settlement-
 * safe streaming protocol.
 */
export class ArchymedesCloudTurnProvider implements AgentTurnProvider {
  readonly capabilities: ModelCapabilities;
  private readonly fetchImpl: typeof fetch;
  private readonly completionUrl: string;
  private readonly model: string;
  private readonly maximumMicros: number;
  private readonly currency: string;
  private readonly dataPolicy: ArchymedesCloudDataPolicy;
  private readonly qualityFloor: number;

  constructor(private readonly options: ArchymedesCloudAgentOptions) {
    if (!options.token.trim()) throw new Error("ARCHYMEDES_CLOUD_TOKEN is required");
    if (!options.baseURL.trim()) throw new Error("ARCHYMEDES_CLOUD_BASE_URL is required");
    const maximum = options.maximumMicros ?? 5_000_000;
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Archymedes Cloud maximum must be a positive integer number of micros");
    const currency = (options.currency ?? "USD").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Archymedes Cloud currency must be a three-letter ISO code");
    const dataPolicy = options.dataPolicy ?? "standard";
    if (!["standard", "no-training", "zero-retention", "local-only"].includes(dataPolicy)) throw new Error("Archymedes Cloud data policy is invalid");
    const qualityFloor = options.qualityFloor ?? 0;
    if (!Number.isFinite(qualityFloor) || qualityFloor < 0 || qualityFloor > 1) throw new Error("Archymedes Cloud quality floor must be between zero and one");

    this.model = options.model?.trim() || "auto";
    this.maximumMicros = maximum;
    this.currency = currency;
    this.dataPolicy = dataPolicy as ArchymedesCloudDataPolicy;
    this.qualityFloor = qualityFloor;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const base = options.baseURL.replace(/\/+$/, "");
    this.completionUrl = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    // `auto` has no concrete limits before routing. The conservative fallback prevents the client
    // from constructing a request that an eligible provider cannot hold.
    this.capabilities = capabilitiesFor(this.model);
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    if (!request.safetyIdentifier.trim()) throw new Error("safetyIdentifier is required");
    const taskId = `cli_${randomUUID()}`;
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
      ...(request.signal ? [request.signal] : []),
    ]);
    const response = await this.fetchImpl(this.completionUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "x-request-id": taskId,
      },
      body: JSON.stringify({
        model: this.model,
        messages: toWireMessages(request.messages),
        ...(request.tools.length > 0 ? {
          tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
          tool_choice: "auto",
          parallel_tool_calls: true,
        } : {}),
        max_completion_tokens: request.maxOutputTokens,
        safety_identifier: request.safetyIdentifier,
        prompt_cache_key: request.safetyIdentifier,
        ...(request.effort ? { reasoning_effort: request.effort } : {}),
        stream: false,
        archymedes: {
          task_id: taskId,
          maximum: { currency: this.currency, micros: this.maximumMicros },
          profile: {
            kind: "coding",
            requiredCapabilities: request.tools.length > 0 ? ["tools"] : [],
            dataPolicy: this.dataPolicy,
            ...(this.options.region?.trim() ? { region: this.options.region.trim() } : {}),
            qualityFloor: this.qualityFloor,
          },
        },
      }),
      signal,
    });

    const body = await readBody(response);
    if (!response.ok) {
      const problem = body as { error?: { code?: unknown; message?: unknown } };
      const code = typeof problem?.error?.code === "string" ? problem.error.code : undefined;
      const detail = typeof problem?.error?.message === "string" ? problem.error.message : `Exchange returned HTTP ${response.status}`;
      throw new ArchymedesCloudError(response.status, detail.slice(0, 500), code);
    }
    return turnFromChatResponse(body as ChatResponse);
  }
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.ok) throw new Error("Archymedes Cloud returned an invalid JSON completion");
    return {};
  }
}
