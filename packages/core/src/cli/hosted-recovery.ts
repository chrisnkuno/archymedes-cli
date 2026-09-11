import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage, AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { priceActualModelUsage, type ModelPriceCatalog } from "../model-cost";
import { mergeRoutingReceipts } from "../providers/routing-receipt";
import type { SessionRecord } from "./session";

/**
 * Private recovery snapshots, not telemetry. Exact request content is needed to replay an
 * idempotent completion. Requests and replies stay mode 0600 beside the session, never in logs.
 * The caller must hold session ownership for every operation, including recovery and cleanup.
 */
type SavedRequest = Pick<AgentModelRequest, "requestId" | "messages" | "tools" | "maxOutputTokens" | "safetyIdentifier" | "effort">;
type Entry = {
  request: SavedRequest;
  fingerprint: string;
  kind: string;
  prices: ModelPriceCatalog;
  state: "pending" | "completed" | "failed" | "ambiguous" | "cancelled";
  response?: AgentModelTurn;
};
type Batch = {
  version: 1;
  id: string;
  sessionId: string;
  scope: string;
  baseTotalRwf: number;
  entries: Entry[];
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function savedRequest(request: AgentModelRequest): SavedRequest {
  return JSON.parse(JSON.stringify({
    requestId: request.requestId ?? `cli_${randomUUID()}`, messages: request.messages,
    tools: request.tools, maxOutputTokens: request.maxOutputTokens,
    safetyIdentifier: request.safetyIdentifier, ...(request.effort ? { effort: request.effort } : {}),
  })) as SavedRequest;
}

function validateBatch(value: unknown, sessionId: string): Batch {
  const batch = value as Batch;
  if (!batch || batch.version !== 1 || batch.sessionId !== sessionId || typeof batch.id !== "string"
    || typeof batch.scope !== "string" || !Number.isSafeInteger(batch.baseTotalRwf) || batch.baseTotalRwf < 0 || !Array.isArray(batch.entries)) {
    throw new Error("Invalid hosted recovery snapshot; preserve the file for inspection.");
  }
  const ids = new Set<string>();
  for (const entry of batch.entries) {
    if (!entry || !entry.request || typeof entry.request.requestId !== "string" || ids.has(entry.request.requestId)
      || !Array.isArray(entry.request.messages) || !Array.isArray(entry.request.tools)
      || digest(entry.request) !== entry.fingerprint || !["pending", "completed", "failed", "ambiguous", "cancelled"].includes(entry.state)
      || typeof entry.kind !== "string" || !entry.prices || (entry.state === "completed" && !entry.response)) {
      throw new Error("Invalid hosted recovery request; refusing to replay changed content.");
    }
    ids.add(entry.request.requestId);
  }
  return batch;
}

export class HostedRecoveryStore {
  private batch: Batch | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  readonly file: string;

  constructor(root: string, private readonly sessionId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new Error("Unsafe recovery session id");
    this.file = path.join(root, ".archymedes", "recovery", `${sessionId}.json`);
  }

  private async read(): Promise<Batch | undefined> {
    let text: string;
    try { text = await fs.readFile(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const parsed = JSON.parse(text) as { batch: unknown; integrity: string };
    if (digest(parsed.batch) !== parsed.integrity) throw new Error("Hosted recovery snapshot integrity check failed");
    return validateBatch(parsed.batch, this.sessionId);
  }

  private async write(batch: Batch): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ batch, integrity: digest(batch) })); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, this.file);
      // Persist the name before dispatch as well as the file's content.
      const directory = await fs.open(path.dirname(this.file), "r").catch(() => null);
      if (directory) { try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }

  wrap(provider: AgentTurnProvider, session: () => SessionRecord, prices: ModelPriceCatalog, kind: string): AgentTurnProvider {
    if (!provider.recoveryScope) return provider;
    return {
      capabilities: provider.capabilities,
      complete: (request) => {
        const operation = this.tail.then(() => this.complete(provider, session(), prices, kind, request));
        this.tail = operation.catch(() => undefined);
        return operation;
      },
    };
  }

  private async complete(provider: AgentTurnProvider, session: SessionRecord, prices: ModelPriceCatalog, kind: string, request: AgentModelRequest): Promise<AgentModelTurn> {
    request.signal?.throwIfAborted();
    if (!this.batch) {
      if (await this.read()) throw new Error("Recover the interrupted hosted request before starting new work.");
      this.batch = { version: 1, id: randomUUID(), sessionId: this.sessionId, scope: provider.recoveryScope!, baseTotalRwf: session.totalRwf, entries: [] };
    }
    if (this.batch.scope !== provider.recoveryScope) throw new Error("Hosted recovery provider configuration changed");
    const saved = savedRequest(request);
    let entry = this.batch.entries.find((item) => item.request.requestId === saved.requestId);
    if (entry && entry.fingerprint !== digest(saved)) throw new Error("Hosted request identity reused with changed content");
    if (!entry) {
      entry = { request: saved, fingerprint: digest(saved), kind, prices: { ...prices }, state: "pending" };
      this.batch.entries.push(entry);
      await this.write(this.batch);
    }
    await this.write(this.batch);
    return this.dispatch(provider, this.batch, entry, request.signal);
  }

  private async dispatch(provider: AgentTurnProvider, batch: Batch, entry: Entry, signal?: AbortSignal, recoveryOnly = false): Promise<AgentModelTurn> {
    if (entry.response) { await this.write(batch); return entry.response; }
    if (entry.state === "failed") throw new Error("Hosted request was previously confirmed failed");
    if (!recoveryOnly && signal?.aborted) {
      entry.state = "failed"; // Persisted, but dispatch definitely did not begin.
      await this.write(batch);
      signal.throwIfAborted();
    }
    try {
      // A dedicated recovery-only entry point exists only to stop a provider that can create new
      // work (a fresh reservation, a fresh provider call) from doing that during recovery. A
      // provider with no such distinction has nothing extra to protect against, so reuse `complete`.
      const method = recoveryOnly && provider.recoverComplete ? provider.recoverComplete : provider.complete;
      const response = await method.call(provider, { ...entry.request, signal });
      entry.response = JSON.parse(JSON.stringify(response)) as AgentModelTurn;
      entry.state = "completed";
      await this.write(batch);
      return response;
    } catch (error) {
      // A lost response, timeout or cancellation is not proof that no provider work was charged.
      // Only the exchange's explicit terminal record closes an unsuccessful operation.
      if (!entry.response) {
        entry.state = (error as { code?: string })?.code === "request_previously_failed" ? "failed" : signal?.aborted ? "cancelled" : "ambiguous";
        await this.write(batch);
      }
      throw error;
    }
  }

  responses(): Array<{ requestId: string; turn: AgentModelTurn }> {
    return (this.batch?.entries ?? []).flatMap((entry) => entry.response ? [{ requestId: entry.request.requestId!, turn: entry.response }] : []);
  }

  /** Marker saved in the same atomic session snapshot as the transcript and accounting. */
  settledBatchId(): string | undefined {
    return this.batch?.entries.every((entry) => entry.state === "completed" || entry.state === "failed") ? this.batch.id : undefined;
  }

  async cleanup(committedId?: string): Promise<void> {
    const batch = this.batch ?? await this.read();
    if (batch && batch.id === committedId) {
      await fs.unlink(this.file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      this.batch = undefined;
    }
  }

  async recover(provider: AgentTurnProvider, session: SessionRecord, signal?: AbortSignal): Promise<SessionRecord | null> {
    const batch = await this.read();
    if (!batch) return null;
    if (session.hostedRecoveryBatchId === batch.id) { await this.cleanup(batch.id); return null; }
    if (!provider.recoveryScope || batch.scope !== provider.recoveryScope) {
      throw new Error("An interrupted hosted request belongs to a different provider, credential or routing configuration. Resume with the original configuration to recover it.");
    }
    for (const entry of batch.entries) {
      if (entry.state === "failed" || entry.response) continue;
      try { await this.dispatch(provider, batch, entry, signal, true); }
      catch (error) {
        if ((error as { code?: string })?.code === "request_previously_failed") continue;
        const failure = new Error(`Hosted request ${entry.request.requestId} remains unresolved. Its identity is preserved; resume again to reconcile it.`, { cause: error });
        throw failure;
      }
    }
    this.batch = batch;
    const main = batch.entries.filter((entry) => entry.kind === "main").at(-1);
    const messages: AgentMessage[] = main ? [...main.request.messages] : [...session.messages];
    if (main?.response) {
      const response = main.response;
      if (response.toolCalls.length) {
        messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });
        for (const call of response.toolCalls) messages.push({ role: "tool", toolCallId: call.id, name: call.name,
          content: "Interrupted execution: the tool outcome is unknown. Do not repeat this action without inspecting the current state. Recovery did not replay the tool." });
      } else messages.push({ role: "assistant", content: response.content || response.refusal || "Recovered hosted response with no text." });
    }
    // Keep recovered auxiliary work available without treating its tool intent as authorization.
    for (const entry of batch.entries.filter((item) => item.kind !== "main" && item.response)) {
      messages.push({ role: "assistant", content: `[Recovered ${entry.kind.startsWith("delegate") ? "delegated work" : "compaction"}]\n${entry.response!.content}` });
    }
    messages.push({ role: "user", internal: true, content: "The previous run was interrupted. Hosted responses and usage were recovered. Tool execution may be incomplete; inspect the workspace and verify before repeating side effects or claiming completion." });
    const groups = new Map<string, { input: number; output: number; prices: ModelPriceCatalog }>();
    for (const entry of batch.entries) if (entry.response) {
      const group = groups.get(entry.kind) ?? { input: 0, output: 0, prices: entry.prices };
      group.input += entry.response.usage.inputTokens;
      group.output += entry.response.usage.outputTokens;
      groups.set(entry.kind, group);
    }
    const cost = [...groups.values()].reduce((sum, group) => sum + priceActualModelUsage(group.input, group.output, group.prices), 0);
    return { ...session, messages, totalRwf: batch.baseTotalRwf + cost, hostedRecoveryBatchId: batch.id,
      routingReceipts: mergeRoutingReceipts(session.routingReceipts, batch.entries.flatMap((entry) => entry.response?.routingReceipt ? [{ ...entry.response.routingReceipt, taskId: entry.response.routingReceipt.taskId ?? entry.request.requestId }] : [])),
    };
  }
}
