import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { ArchymedesAgent } from "./agent";
import { ArchymedesSessionDaemon, PREVIEW_HUNK_SEPARATOR, type DaemonAgentFactoryContext, type DaemonApprovalRequest, type DaemonNotification } from "./daemon";
import { loadSession } from "./session";

const prices = { inputRatePerMillion: 2_000, outputRatePerMillion: 8_000 };
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
let root: string;
let daemon: ArchymedesSessionDaemon;

function modelWith(
  complete: (request: AgentModelRequest, call: number) => Promise<Partial<AgentModelTurn>> | Partial<AgentModelTurn>,
): AgentTurnProvider & { calls: number } {
  return {
    calls: 0,
    async complete(request) {
      this.calls += 1;
      return {
        responseId: `response_${this.calls}`,
        model: "daemon-test",
        finishReason: "stop",
        content: "Done.",
        toolCalls: [],
        usage,
        ...await complete(request, this.calls),
      } as AgentModelTurn;
    },
  };
}

function factory(model: AgentTurnProvider) {
  return ({ onEvent, approve }: DaemonAgentFactoryContext) => new ArchymedesAgent({
    root,
    model,
    prices,
    mode: "build",
    approve,
    onEvent,
    git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repository" }),
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-daemon-"));
  await fs.writeFile(path.join(root, "app.ts"), "export const value = 1;\n");
  daemon = new ArchymedesSessionDaemon();
});

afterEach(async () => {
  await daemon.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

describe("ArchymedesSessionDaemon", () => {
  it("isolates receipts by active session and retains them through handoff and disk resume", async () => {
    const model = modelWith(() => ({ routingReceipt: {
      chosen: { model: "hosted" }, considered: [], policy: {}, retries: 0, currency: "USD", actualMicros: 100,
    } }));
    const first = daemon.connect();
    await first.open(factory(model));
    await first.send("first");
    const receipts = first.routingReceipts;
    expect(receipts).toHaveLength(1);
    expect(receipts[0].taskId).toMatch(/^cli_/);
    const second = daemon.connect();
    await second.open(factory(model));
    expect(second.routingReceipts).toEqual([]);
    await second.send("second");
    expect(second.routingReceipts[0].taskId).not.toBe(receipts[0].taskId);
    expect(first.routingReceipts).toEqual(receipts);
    receipts[0].chosen.model = "mutated copy";
    expect(first.routingReceipts[0].chosen.model).toBe("hosted");
    const handoff = await first.relinquish();
    const replacement = daemon.connect();
    await replacement.open(factory(model), handoff);
    expect(replacement.routingReceipts).toHaveLength(1);
    const id = replacement.sessionId;
    await replacement.relinquish();
    const cleared = daemon.connect();
    await cleared.open(factory(model));
    expect(cleared.routingReceipts).toEqual([]);
    const stored = await loadSession(root, id);
    await daemon.shutdown();
    daemon = new ArchymedesSessionDaemon();
    const resumed = daemon.connect();
    await resumed.open(factory(model), stored!);
    expect(resumed.routingReceipts).toEqual(stored!.routingReceipts);
    await resumed.send("continue");
    expect(resumed.routingReceipts).toHaveLength(2);
    expect((await loadSession(root, id))!.routingReceipts).toHaveLength(2);
  });

  it("owns one session while multiple clients attach to it", async () => {
    const model = modelWith(() => ({ content: "Shared result." }));
    const first = daemon.connect({ id: "tui" });
    const opened = await first.open(factory(model));
    first.disconnect();

    const ide = daemon.connect({ id: "ide" });
    expect(ide.attach(opened.sessionId).sessionId).toBe(opened.sessionId);
    expect((await ide.send("continue", "command_1")).summary).toBe("Shared result.");
    expect(model.calls).toBe(1);

    const saved = await loadSession(root, opened.sessionId);
    expect(saved?.messages.some((message) => message.content === "continue")).toBe(true);
  });

  it("binds retries to one result by command id", async () => {
    const model = modelWith(() => ({ content: "Only once." }));
    const client = daemon.connect({ id: "headless" });
    await client.open(factory(model));

    const first = client.send("do it", "stable_request");
    const retry = client.send("do it", "stable_request");
    expect(retry).toBe(first);
    expect((await retry).summary).toBe("Only once.");
    expect(model.calls).toBe(1);
  });

  it("serializes different turns for the same session", async () => {
    let active = 0;
    let maximum = 0;
    const order: string[] = [];
    const model = modelWith(async (request) => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(request.messages.at(-1)?.content ?? "");
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { content: "ok" };
    });
    const client = daemon.connect({ id: "tests" });
    await client.open(factory(model));
    await Promise.all([
      client.send("first", "command_first"),
      client.send("second", "command_second"),
    ]);
    expect(maximum).toBe(1);
    expect(order).toEqual(["first", "second"]);
  });

  it("returns the complete transcript atomically when a model handoff retires the agent", async () => {
    const firstModel = modelWith(() => ({ content: "The project codename is cobalt." }));
    const first = daemon.connect({ id: "before-model-switch" });
    await first.open(factory(firstModel));
    await first.send("Remember the project codename.", "command_remember");

    const carried = await first.relinquish();
    expect(carried?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Remember the project codename." }),
      expect.objectContaining({ role: "assistant", content: "The project codename is cobalt." }),
    ]));

    const requests: AgentModelRequest[] = [];
    const secondModel = modelWith((request) => {
      requests.push(request);
      return { content: "cobalt" };
    });
    const second = daemon.connect({ id: "after-model-switch" });
    await second.open(factory(secondModel), carried);
    await second.send("What was the codename?", "command_recall");

    expect(requests[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Remember the project codename." }),
      expect.objectContaining({ role: "assistant", content: "The project codename is cobalt." }),
    ]));
    expect(requests[0].messages.at(-1)).toEqual({ role: "user", content: "What was the codename?" });
  });

  it("brokers approvals through the attached client and fans out events", async () => {
    const notifications: DaemonNotification[] = [];
    const model = modelWith((_request, call) => call === 1
      ? { finishReason: "tool_calls", content: "", toolCalls: [{ id: "edit_1", name: "edit_file", arguments: { path: "app.ts", oldText: "1", newText: "2" } }] }
      : { content: "Edited." });
    const client = daemon.connect({
      id: "desktop",
      onNotification: (notification) => notifications.push(notification),
      approve: async (request) => request.toolName === "edit_file" ? "allow" : "deny",
    });
    await client.open(factory(model));
    const result = await client.send("edit it", "command_edit");
    expect(result.status).toBe("needs_verification");
    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toContain("2");
    expect(notifications.some((event) => event.type === "turn_started")).toBe(true);
    expect(notifications.some((event) => event.type === "agent_event")).toBe(true);
    expect(notifications.some((event) => event.type === "turn_finished")).toBe(true);
  });

  it("carries the safety assessment on an approval request, not just its summary", async () => {
    // A client rebuilding the terminal's "Safety guard: ..." warning needs to know *why* auto mode
    // did not silently approve the call — dropping this field would silently lose that warning for
    // any client built against the daemon instead of the in-process ApprovalRequest.
    let seenSafety: unknown;
    const model = modelWith((_request, call) => call === 1
      ? { finishReason: "tool_calls", content: "", toolCalls: [{ id: "run_1", name: "run_command", arguments: { command: "git push" } }] }
      : { content: "Pushed." });
    const client = daemon.connect({
      id: "safety-check",
      approve: async (request) => { seenSafety = request.safety; return "deny" as const; },
    });
    await client.open(({ onEvent, approve }) => new ArchymedesAgent({
      root, model, prices, mode: "auto", approve, onEvent, git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repository" }),
    }));
    await client.send("push it", "command_push");
    expect(seenSafety).toMatchObject({ sensitive: true, categories: expect.arrayContaining(["production"]) });
  });

  it("carries what an edit_file or write_file call would change, for a client to preview before deciding", async () => {
    let seenPreviews: unknown[] = [];
    const model = modelWith((_request, call) => {
      if (call === 1) return { finishReason: "tool_calls", content: "", toolCalls: [{ id: "edit_1", name: "edit_file", arguments: { path: "app.ts", oldText: "1", newText: "2" } }] };
      if (call === 2) return { finishReason: "tool_calls", content: "", toolCalls: [{ id: "write_1", name: "write_file", arguments: { path: "new.ts", content: "export const x = 1;\n" } }] };
      return { content: "Done." };
    });
    const client = daemon.connect({
      id: "preview-check",
      approve: async (request) => { seenPreviews.push(request.preview); return "allow" as const; },
    });
    await client.open(factory(model));
    await client.send("edit and add a file", "command_preview");
    expect(seenPreviews[0]).toEqual({ toolName: "edit_file", path: "app.ts", oldText: "1", newText: "2" });
    expect(seenPreviews[1]).toEqual({ toolName: "write_file", path: "new.ts", content: "export const x = 1;\n" });
  });

  it("carries no preview for a tool with no textual before/after, like run_command", async () => {
    let seenPreview: unknown = "not set";
    const model = modelWith((_request, call) => call === 1
      ? { finishReason: "tool_calls", content: "", toolCalls: [{ id: "run_1", name: "run_command", arguments: { command: "npm test" } }] }
      : { content: "Ran it." });
    const client = daemon.connect({
      id: "no-preview-check",
      approve: async (request) => { seenPreview = request.preview; return "allow" as const; },
    });
    await client.open(factory(model));
    await client.send("run the tests", "command_run");
    expect(seenPreview).toBeUndefined();
  });

  it("previews the multi-edit form hunk by hunk, parsed the way the tool parses it", async () => {
    const seenPreviews: unknown[] = [];
    const edits = [{ oldText: "const", newText: "let" }, { oldText: "1", newText: "2", replaceAll: true }];
    const model = modelWith((_request, call) => {
      if (call === 1) return { finishReason: "tool_calls", content: "", toolCalls: [{ id: "edit_1", name: "edit_file", arguments: { path: "app.ts", edits: JSON.stringify(edits) } }] };
      if (call === 2) return { finishReason: "tool_calls", content: "", toolCalls: [{ id: "edit_2", name: "edit_file", arguments: { path: "app.ts", edits: "not json" } }] };
      return { content: "Done." };
    });
    const client = daemon.connect({
      id: "multi-edit-preview",
      approve: async (request) => { seenPreviews.push(request.preview); return seenPreviews.length === 1 ? "allow" as const : "deny" as const; },
    });
    await client.open(factory(model));
    await client.send("edit twice", "command_multi");
    expect(seenPreviews[0]).toEqual({
      toolName: "edit_file",
      path: "app.ts",
      oldText: `const${PREVIEW_HUNK_SEPARATOR}1`,
      newText: `let${PREVIEW_HUNK_SEPARATOR}2`,
      edits: [{ oldText: "const", newText: "let", replaceAll: false }, { oldText: "1", newText: "2", replaceAll: true }],
    });
    // Malformed edits the tool would reject get no preview rather than a guessed one.
    expect(seenPreviews[1]).toBeUndefined();
    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toBe("export let value = 2;\n");
  });

  it("forwards the offered pattern and round-trips allow_pattern into a standing rule", async () => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");
    const seen: DaemonApprovalRequest[] = [];
    const model = modelWith((_request, call) => {
      if (call === 1) return { finishReason: "tool_calls", content: "", toolCalls: [{ id: "edit_a", name: "edit_file", arguments: { path: "src/a.ts", oldText: "1", newText: "2" } }] };
      if (call === 2) return { finishReason: "tool_calls", content: "", toolCalls: [{ id: "edit_b", name: "edit_file", arguments: { path: "src/b.ts", oldText: "1", newText: "2" } }] };
      return { content: "Done." };
    });
    const client = daemon.connect({
      id: "pattern-check",
      approve: async (request) => { seen.push(request); return "allow_pattern" as const; },
    });
    await client.open(factory(model));
    await client.send("edit both", "command_pattern");
    // Only the first edit asked: the granted directory rule covered the second.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pattern).toEqual({ kind: "directory", directory: "src", label: "always allow edits under src/" });
    expect(await fs.readFile(path.join(root, "src", "b.ts"), "utf8")).toBe("export const b = 2;\n");
  });

  it("round-trips allow_pattern through a notification-driven decideApproval too", async () => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    const model = modelWith((_request, call) => call === 1
      ? { finishReason: "tool_calls", content: "", toolCalls: [{ id: "edit_a", name: "edit_file", arguments: { path: "src/a.ts", oldText: "1", newText: "2" } }] }
      : { content: "Done." });
    let client: ReturnType<ArchymedesSessionDaemon["connect"]> | undefined;
    client = daemon.connect({
      id: "remote-ui",
      onNotification: (notification) => {
        if (notification.type !== "approval_requested") return;
        expect(notification.request.pattern?.kind).toBe("directory");
        queueMicrotask(() => client!.decideApproval(notification.request.id, "allow_pattern"));
      },
    });
    await client.open(factory(model));
    await client.send("edit", "command_remote");
    expect(await fs.readFile(path.join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });
});
