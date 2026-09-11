import { createHash, randomUUID } from "node:crypto";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { toWireMessages, turnFromChatResponse, type ChatResponse } from "./openai-compatible";
import { capabilitiesFor, type ModelCapabilities } from "./model-capabilities";
import { buildTaskProfile, TASK_KINDS, type TaskKind } from "./routing-receipt";
import { parseRoutingPlan, type RoutingPlan } from "./routing-plan";
import { parseCreditBalance, type CreditBalance } from "./credit-balance";

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
  /** The unit of work the exchange is routing — steers model selection. Defaults to "coding". */
  taskKind?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** An HTTP failure whose status remains visible to the runtime's bounded retry policy. */
export class ArchymedesCloudError extends Error {
  readonly retryable?: boolean;
  constructor(readonly status: number, message: string, readonly code?: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ArchymedesCloudError";
    if (["request_previously_failed", "idempotency_conflict", "spend_limit_exceeded"].includes(code ?? "")) this.retryable = false;
    else if (code === "request_in_progress") this.retryable = true;
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
  readonly recoveryScope: string;
  private readonly fetchImpl: typeof fetch;
  private readonly completionUrl: string;
  private readonly planUrl: string;
  private readonly balanceUrl: string;
  private readonly model: string;
  private readonly maximumMicros: number;
  private readonly currency: string;
  private readonly dataPolicy: ArchymedesCloudDataPolicy;
  private readonly qualityFloor: number;
  private readonly taskKind: TaskKind;

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
    const requestedKind = options.taskKind?.trim().toLowerCase();
    if (requestedKind !== undefined && !(TASK_KINDS as readonly string[]).includes(requestedKind)) throw new Error(`Archymedes Cloud task kind must be one of: ${TASK_KINDS.join(", ")}`);
    this.taskKind = requestedKind as TaskKind | undefined ?? "coding";
    this.fetchImpl = options.fetchImpl ?? fetch;
    const base = options.baseURL.replace(/\/+$/, "");
    this.completionUrl = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    this.planUrl = base.endsWith("/v1") ? `${base}/routes/plan` : `${base}/v1/routes/plan`;
    this.balanceUrl = base.endsWith("/v1") ? `${base}/credits/balance` : `${base}/v1/credits/balance`;
    // `auto` has no concrete limits before routing. The conservative fallback prevents the client
    // from constructing a request that an eligible provider cannot hold.
    this.capabilities = capabilitiesFor(this.model);
    // Bind recovery to the effective request configuration and credential, never persist the token.
    this.recoveryScope = createHash("sha256").update(JSON.stringify({
      version: 1, endpoint: this.completionUrl, token: options.token, model: this.model,
      maximum: this.maximumMicros, currency: this.currency, policy: this.dataPolicy,
      quality: this.qualityFloor, kind: this.taskKind, region: options.region,
    })).digest("hex");
  }

  /**
   * Asks what the next turn would be routed to, without running it.
   *
   * This is deliberately not a completion against a throwaway budget: planning must not reserve
   * credit, call a provider or touch the conversation, so it goes to the exchange's read-only
   * planning endpoint and sends the *size* of the prospective request rather than its content. The
   * profile is built by the same `buildTaskProfile` call the real turn uses, because a preflight
   * that quietly plans a different request than it would send is worse than no preflight.
   *
   * Returns null when the exchange answers with something that is not a plan; the caller shows
   * that as "no plan available", never as "no routes".
   */
  async plan(input: { estimatedInputTokens: number; maxOutputTokens: number; usesTools?: boolean; effort?: string; signal?: AbortSignal }): Promise<RoutingPlan | null> {
    if (!Number.isSafeInteger(input.estimatedInputTokens) || input.estimatedInputTokens < 1) {
      throw new Error("estimatedInputTokens must be a positive integer");
    }
    input.signal?.throwIfAborted();
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    const response = await this.fetchImpl(this.planUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: input.maxOutputTokens,
        archymedes: {
          estimated_input_tokens: input.estimatedInputTokens,
          maximum: { currency: this.currency, micros: this.maximumMicros },
          profile: buildTaskProfile({
            kind: this.taskKind,
            requiredCapabilities: [
              ...(input.usesTools ? ["tools"] : []),
              ...(input.effort ? ["reasoning"] : []),
            ],
            dataPolicy: this.dataPolicy,
            region: this.options.region,
            qualityFloor: this.qualityFloor,
          }),
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
    return parseRoutingPlan(body);
  }

  /**
   * Reads the account's hosted credit balance.
   *
   * A plain read: it moves no money and reserves nothing, so it carries no idempotency key. The
   * currency asked for is the one this provider reserves in, so the figure the user sees is the
   * figure their next turn will actually draw against — converting it here would put a number on
   * screen that no reservation is denominated in.
   */
  async creditBalance(signal?: AbortSignal): Promise<CreditBalance | null> {
    signal?.throwIfAborted();
    const merged = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      ...(signal ? [signal] : []),
    ]);
    const response = await this.fetchImpl(`${this.balanceUrl}?currency=${encodeURIComponent(this.currency)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.options.token}`, accept: "application/json" },
      signal: merged,
    });
    const body = await readBody(response);
    if (!response.ok) {
      const problem = body as { error?: { code?: unknown; message?: unknown } };
      const code = typeof problem?.error?.code === "string" ? problem.error.code : undefined;
      const detail = typeof problem?.error?.message === "string" ? problem.error.message : `Exchange returned HTTP ${response.status}`;
      throw new ArchymedesCloudError(response.status, detail.slice(0, 500), code);
    }
    return parseCreditBalance(body);
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    return this.exchange(request, false);
  }

  async recoverComplete(request: AgentModelRequest): Promise<AgentModelTurn> {
    return this.exchange(request, true);
  }

  private async exchange(request: AgentModelRequest, recoveryOnly: boolean): Promise<AgentModelTurn> {
    if (!request.safetyIdentifier.trim()) throw new Error("safetyIdentifier is required");
    const taskId = request.requestId ?? `cli_${randomUUID()}`;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new Error("requestId must contain 1 to 160 letters, numbers, underscores or hyphens");
    request.signal?.throwIfAborted();
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
      ...(request.signal ? [request.signal] : []),
    ]);
    const response = await this.fetchImpl(recoveryOnly ? `${this.completionUrl}/recover` : this.completionUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "idempotency-key": taskId,
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
          profile: buildTaskProfile({
            kind: this.taskKind,
            requiredCapabilities: [
              ...(request.tools.length > 0 ? ["tools"] : []),
              ...(request.effort ? ["reasoning"] : []),
            ],
            dataPolicy: this.dataPolicy,
            region: this.options.region,
            qualityFloor: this.qualityFloor,
          }),
        },
      }),
      signal,
    });

    const body = await readBody(response);
    if (!response.ok) {
      const problem = body as { error?: { code?: unknown; message?: unknown } };
      const code = typeof problem?.error?.code === "string" ? problem.error.code : undefined;
      const detail = typeof problem?.error?.message === "string" ? problem.error.message : `Exchange returned HTTP ${response.status}`;
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter === null ? undefined : /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      throw new ArchymedesCloudError(response.status, detail.slice(0, 500), code,
        retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
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
