import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { HostedRecoveryStore } from "./hosted-recovery";
import { ArchymedesAgent } from "./agent";
import { loadSession, saveSession, type SessionRecord } from "./session";
import { readEventJournal } from "./protocol";
import { ArchymedesCloudTurnProvider } from "../providers/archymedes-cloud-agent";

const prices = { inputRatePerMillion: 2_000, outputRatePerMillion: 8_000 };
const request: AgentModelRequest = { requestId: "cli_original", messages: [{ role: "user", content: "private objective" }], tools: [], maxOutputTokens: 100, safetyIdentifier: "test-session" };
const turn: AgentModelTurn = { responseId: "response", model: "model", content: "Recovered answer", finishReason: "stop", toolCalls: [], usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, routingReceipt: { chosen: { model: "model" }, taskId: "cli_original", considered: [], policy: {}, retries: 0 } };
let root: string;
const record = (): SessionRecord => ({ schemaVersion: 2, revision: 0, id: "session", root, title: "task", messages: [], approvals: {}, totalRwf: 0, createdAt: 1, updatedAt: 1 });
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-recovery-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("hosted recovery", () => {
  it("persists before dispatch, reuses identity after a lost response and commits exactly once", async () => {
    const session = record();
    const store = new HostedRecoveryStore(root, session.id);
    let calls = 0;
    const provider: AgentTurnProvider = { recoveryScope: "account", complete: async (actual) => {
      calls++;
      const data = JSON.parse(await fs.readFile(store.file, "utf8"));
      expect(data.batch.entries[0].request.requestId).toBe(actual.requestId);
      if (calls === 1) throw new Error("response lost after settlement");
      expect(actual).toMatchObject(request);
      return turn;
    } };
    await expect(store.wrap(provider, () => session, prices, "main").complete(request)).rejects.toThrow("response lost");
    expect((await fs.stat(store.file)).mode & 0o777).toBe(0o600);
    const restarted = new HostedRecoveryStore(root, session.id);
    const recovered = await restarted.recover(provider, session);
    expect(recovered?.messages.some((message) => message.content === turn.content)).toBe(true);
    expect(recovered?.routingReceipts).toHaveLength(1);
    await saveSession(recovered!);
    // Crash after snapshot commit, before recovery-file cleanup.
    const afterCommit = new HostedRecoveryStore(root, session.id);
    expect(await afterCommit.recover(provider, recovered!)).toBeNull();
    expect(calls).toBe(2);
    expect(await fs.stat(store.file).catch(() => null)).toBeNull();
  });

  it("reuses a locally saved response without another HTTP request", async () => {
    const session = record();
    const provider = { recoveryScope: "account", complete: async () => turn };
    const store = new HostedRecoveryStore(root, session.id);
    await store.wrap(provider, () => session, prices, "main").complete(request);
    const restarted = new HostedRecoveryStore(root, session.id);
    const recovered = await restarted.recover({ recoveryScope: "account", complete: async () => { throw new Error("must not dispatch"); } }, session);
    expect(recovered?.messages.some((message) => message.content === turn.content)).toBe(true);
  });

  it("rejects changed content and a different provider scope", async () => {
    const session = record();
    const store = new HostedRecoveryStore(root, session.id);
    const provider = { recoveryScope: "account", complete: async () => turn };
    const wrapped = store.wrap(provider, () => session, prices, "main");
    await wrapped.complete(request);
    await expect(wrapped.complete({ ...request, maxOutputTokens: 99 })).rejects.toThrow("changed content");
    await expect(new HostedRecoveryStore(root, session.id).recover({ ...provider, recoveryScope: "other-account" }, session)).rejects.toThrow("different provider");
  });

  it("retains cancellation as unresolved and never executes recovered tools", async () => {
    const session = record();
    const controller = new AbortController();
    const store = new HostedRecoveryStore(root, session.id);
    await expect(store.wrap({ recoveryScope: "account", complete: async () => { controller.abort(); throw new Error("cancelled"); } }, () => session, prices, "main").complete({ ...request, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(JSON.parse(await fs.readFile(store.file, "utf8")).batch.entries[0].state).toBe("cancelled");
    const recovered = await new HostedRecoveryStore(root, session.id).recover({ recoveryScope: "account", complete: async () => ({ ...turn, finishReason: "tool_calls", toolCalls: [{ id: "write", name: "write_file", arguments: { path: "never-created", content: "x" } }] }) }, session);
    expect(recovered?.messages.find((message) => message.role === "tool")?.content).toContain("outcome is unknown");
    expect(await fs.stat(path.join(root, "never-created")).catch(() => null)).toBeNull();
  });

  it("keeps in-progress replies recoverable and records only explicit terminal failure", async () => {
    const session = record();
    const store = new HostedRecoveryStore(root, session.id);
    await expect(store.wrap({ recoveryScope: "account", complete: async () => { throw Object.assign(new Error("processing"), { code: "request_in_progress" }); } }, () => session, prices, "main").complete(request)).rejects.toThrow("processing");
    const restarted = new HostedRecoveryStore(root, session.id);
    await expect(restarted.recover({ recoveryScope: "account", complete: async () => { throw new Error("offline"); } }, session)).rejects.toThrow("remains unresolved");
    const failed = await restarted.recover({ recoveryScope: "account", complete: async () => { throw Object.assign(new Error("failed"), { code: "request_previously_failed" }); } }, session);
    expect(failed?.totalRwf).toBe(0);
    expect(failed?.hostedRecoveryBatchId).toBeTruthy();
  });

  it("recovers after SIGKILL following settlement without a second provider call or charge", async () => {
    const cache = new Map<string, { body: string; response: object }>();
    let invocations = 0;
    let charges = 0;
    let received!: () => void;
    const settled = new Promise<void>((resolve) => { received = resolve; });
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const id = String(req.headers["idempotency-key"]);
      const previous = cache.get(id);
      if (previous) {
        if (previous.body !== body) { res.writeHead(409); res.end('{"error":{"code":"idempotency_conflict"}}'); return; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(previous.response));
        return;
      }
      invocations++;
      charges++;
      cache.set(id, { body, response: { id: "paid_response", model: "hosted-model", choices: [{ finish_reason: "stop", message: { content: "Paid answer recovered" } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, archymedes: { routing_receipt: { chosen: { model: "hosted-model" } } } } });
      received(); // Settlement is durable in this fixture; withhold the response until the client dies.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const baseURL = `http://127.0.0.1:${address.port}`;
    const agentPath = fileURLToPath(new URL("./agent.ts", import.meta.url));
    const providerPath = fileURLToPath(new URL("../providers/archymedes-cloud-agent.ts", import.meta.url));
    const script = path.join(root, "crash-client.ts");
    await fs.writeFile(script, `import { ArchymedesAgent } from ${JSON.stringify(agentPath)};\nimport { ArchymedesCloudTurnProvider } from ${JSON.stringify(providerPath)};\nconst agent = new ArchymedesAgent({ root: ${JSON.stringify(root)}, model: new ArchymedesCloudTurnProvider({ token: "fixture-token", baseURL: ${JSON.stringify(baseURL)} }), prices: ${JSON.stringify(prices)}, mode: "plan", approve: async () => "deny" });\nawait agent.send("recover this paid answer");`);
    const child = spawn("bun", [script], { stdio: "ignore" });
    let recoveredAgent: ArchymedesAgent | undefined;
    try {
      await Promise.race([settled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Fixture did not settle")), 8_000); timer.unref(); })]);
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
      const files = await fs.readdir(path.join(root, ".archymedes", "sessions"));
      const sessionId = files.find((file) => file.endsWith(".json"))!.slice(0, -5);
      const saved = await loadSession(root, sessionId);
      expect(saved).not.toBeNull();
      recoveredAgent = new ArchymedesAgent({ root, model: new ArchymedesCloudTurnProvider({ token: "fixture-token", baseURL }), prices, mode: "plan", approve: async () => "deny" });
      recoveredAgent.resume(saved!);
      expect(await recoveredAgent.recoverPending()).toBe(true);
      expect(recoveredAgent.snapshot().messages.some((message) => message.content === "Paid answer recovered")).toBe(true);
      expect(await recoveredAgent.recoverPending()).toBe(false);
      expect(invocations).toBe(1);
      expect(charges).toBe(1);
      const journal = await readEventJournal(root, sessionId);
      expect(journal.filter(({ payload }) => payload.type === "runtime" && payload.event.type === "model_turn")).toHaveLength(1);
    } finally {
      child.kill("SIGKILL");
      await recoveredAgent?.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
