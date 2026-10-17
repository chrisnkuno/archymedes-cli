import { describe, expect, it, vi } from "vitest";
import type { AcpApprovalRequest } from "@archymedes/core/cli/acp";
import type { ArchymedesEvent } from "@archymedes/core/cli/agent";
import type { PermissionDecision } from "@archymedes/core/cli/permissions";
import type { SessionRecord } from "@archymedes/core/cli/session";
import { command, completed, FakeCodex, fileChange, replyWith, type FakeScript } from "./fake-codex";
import { CodexSession, codexPolicy } from "./session";

const ROOT = "/work/project";

function setup(script: FakeScript, options: { record?: SessionRecord; decide?: (request: AcpApprovalRequest) => PermissionDecision; mode?: "plan" | "build" | "auto" } = {}) {
  const codex = new FakeCodex(script);
  const events: ArchymedesEvent[] = [];
  const asked: AcpApprovalRequest[] = [];
  const saved: SessionRecord[] = [];
  const models: string[][] = [];
  const session = new CodexSession({
    root: ROOT, executable: "codex", environment: {}, mode: options.mode ?? "build", record: options.record,
    onEvent: (event) => events.push(event),
    approve: async (request) => { asked.push(request); return options.decide?.(request) ?? "allow"; },
    save: async (record) => { saved.push(structuredClone(record)); },
    onModels: (list) => models.push(list),
    transport: codex.transport,
    // No repository here: checkpoints quietly do nothing, as they do outside git.
    git: async () => ({ exitCode: 128, stdout: "", stderr: "not a git repository" }),
  });
  return { codex, session, events, asked, saved, models };
}

const runtimeTypes = (events: ArchymedesEvent[]) => events.flatMap((event) => (event.type === "runtime" ? [event.event.type] : []));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a session run by Codex", () => {
  it("starts Codex once, streams the reply, reports usage, and saves the turn with Codex's thread", async () => {
    const { codex, session, events, saved, models } = setup(() => [...replyWith("All done."), completed()]);
    await session.open();
    const result = await session.send("Fix the bug");
    expect(result).toEqual({ status: "completed", summary: "All done." });
    expect(codex.starts).toBe(1);
    expect(codex.requests.map((request) => request.method)).toEqual(["initialize", "initialized", "thread/start", "model/list", "turn/start"]);
    expect(runtimeTypes(events)).toEqual(["assistant_delta", "model_turn", "runtime_stop"]);
    const usage = events.find((event) => event.type === "runtime" && event.event.type === "model_turn");
    expect(usage).toMatchObject({ event: { usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 } } });
    expect(saved.at(-1)).toMatchObject({ codexThread: "thread-1", modelSelection: { provider: "codex" }, engineSeen: { codex: 2 } });
    expect(saved.at(-1)!.messages.map((message) => message.content)).toEqual(["Fix the bug", "All done."]);
    await settle();
    expect(models).toEqual([["gpt-5.6-luna", "gpt-6-luna"]]);
  });

  it("shows commands and file changes as the cards people know, with the change's diff as its result", async () => {
    const { session, events } = setup(() => [
      ...command("c1", "python3 calc.py", "5\n"),
      ...fileChange("f1", `${ROOT}/calc.py`, "@@ -1 +1 @@\n-a - b\n+a + b\n"),
      ...command("c2", "python3 missing.py", "No such file", 2),
      ...replyWith("Fixed."),
      completed(),
    ]);
    await session.send("fix calc.py");
    const calls = events.flatMap((event) => (event.type === "runtime" && event.event.type === "tool_call" ? [[event.event.toolName, event.event.arguments]] : []));
    expect(calls).toEqual([["run_command", { command: "python3 calc.py" }], ["edit_file", { path: "calc.py" }], ["run_command", { command: "python3 missing.py" }]]);
    const results = events.flatMap((event) => (event.type === "runtime" && event.event.type === "tool_result" ? [[event.event.isError, event.event.content]] : []));
    expect(results).toEqual([[false, "exit 0\n5"], [false, "--- calc.py\n@@ -1 +1 @@\n-a - b\n+a + b\n"], [true, "exit 2\nNo such file"]]);
  });

  it("puts Codex's approval requests to the person and answers with their decision", async () => {
    const { codex, session, asked } = setup(() => [
      { ask: "item/commandExecution/requestApproval", params: { itemId: "c1", command: "/bin/bash -lc 'npm install'", reason: "needs the network" } },
      ...fileChange("f1", `${ROOT}/a.ts`, "+x"),
      { ask: "item/fileChange/requestApproval", params: { itemId: "f1" } },
      { ask: "item/commandExecution/requestApproval", params: { itemId: "c2", command: "rm -rf dist" } },
      ...replyWith("ok"),
      completed(),
    ], { decide: (request) => (request.toolCallId === "c2" ? "deny" : request.toolCallId === "f1" ? "allow_always" : "allow") });
    await session.send("set it up");
    expect(asked.map((request) => request.summary)).toEqual(["run command: npm install — needs the network", "edit file: a.ts", "run command: rm -rf dist"]);
    expect(codex.answers).toEqual([{ decision: "accept" }, { decision: "acceptForSession" }, { decision: "decline" }]);
  });

  it("deny from now on refuses that tool for the rest of the session without asking", async () => {
    const ask = (id: string) => ({ ask: "item/commandExecution/requestApproval", params: { itemId: id, command: "ls" } });
    const { codex, session, asked } = setup(() => [ask("a"), ask("b"), ...replyWith("ok"), completed()], { decide: () => "deny_always" });
    await session.send("look around");
    expect(asked).toHaveLength(1);
    expect(codex.answers).toEqual([{ decision: "decline" }, { decision: "decline" }]);
  });

  it("stops a turn: interrupts Codex and ends as cancelled, closing open calls", async () => {
    const { codex, session, events } = setup(() => [{ notify: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "sleep 100", status: "inProgress" } } }, { hang: true }]);
    const turn = session.send("wait");
    // Waited for, not slept on: a fixed sleep lost the race on a loaded machine.
    await vi.waitFor(() => expect(runtimeTypes(events)).toContain("tool_call"));
    session.cancel();
    expect(await turn).toEqual({ status: "cancelled", summary: "Stopped." });
    expect(codex.interrupts).toBe(1);
    const closed = events.find((event) => event.type === "runtime" && event.event.type === "tool_result");
    expect(closed).toMatchObject({ event: { isError: true, content: "Stopped before it finished." } });
    expect(runtimeTypes(events).at(-1)).toBe("runtime_stop");
  });

  it("steers a message into the running turn, and refuses one when no turn runs", async () => {
    const { codex, session } = setup(() => [{ hang: true }]);
    expect(session.steer("too early")).toBe(false);
    const turn = session.send("work");
    // A refused steer changes nothing, so it is safe to try until the turn is running.
    await vi.waitFor(() => expect(session.steer("use tabs")).toBe(true));
    await vi.waitFor(() => expect(codex.steers).toEqual(["use tabs"]));
    session.cancel();
    await turn;
  });

  it("says Codex's own reason when a turn fails, not the JSON around it", async () => {
    const providerError = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } });
    const { session } = setup(() => [{ notify: "error", params: { error: { message: providerError }, willRetry: false } }, completed("failed", providerError)]);
    expect(await session.send("hi")).toEqual({ status: "failed", summary: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." });
  });

  it("starts Codex again after it crashes, resuming the same thread", async () => {
    const { codex, session } = setup((_, turn) => (turn === 1 ? [{ crash: "segfault" }] : [...replyWith("back"), completed()]));
    const first = await session.send("one");
    expect(first.status).toBe("failed");
    expect(first.summary).toContain("Codex stopped (segfault)");
    expect(await session.send("two")).toEqual({ status: "completed", summary: "back" });
    expect(codex.starts).toBe(2);
    expect(codex.requests.filter((request) => request.method === "thread/resume").map((request) => (request.params as { threadId: string }).threadId)).toEqual(["thread-1"]);
  });

  it("tells Codex, once, what was said with another model; a thread it no longer has starts anew, told", async () => {
    const record: SessionRecord = { schemaVersion: 2, revision: 1, id: "20261016T000000Z-abc123", createdAt: 1, updatedAt: 2, root: ROOT, title: "Earlier", messages: [{ role: "user", content: "What does main.go do?" }, { role: "assistant", content: "It starts the UI." }], approvals: {}, totalRwf: 0, codexThread: "gone" };
    const { codex, session } = setup(() => [...replyWith("ok"), completed()], { record });
    codex.unknownThreads.add("gone");
    await session.send("Now add a flag");
    await session.send("And test it");
    expect(codex.prompts[0]).toMatch(/^<earlier_conversation [^>]+>\nUser: What does main.go do\?\n\nAssistant: It starts the UI.\n<\/earlier_conversation>\n\nNow add a flag$/);
    expect(codex.prompts[1]).toBe("And test it");
    expect(session.snapshot().codexThread).toBe("thread-1");
  });

  it("coming back to its own thread, is told only what was said while it was away", async () => {
    const record: SessionRecord = {
      schemaVersion: 2, revision: 1, id: "20261016T000000Z-abc124", createdAt: 1, updatedAt: 2, root: ROOT, title: "Earlier", approvals: {}, totalRwf: 0, codexThread: "kept",
      messages: [{ role: "user", content: "first, with Codex" }, { role: "assistant", content: "done" }, { role: "user", content: "then with Claude" }, { role: "assistant", content: "Claude's answer" }],
      engineSeen: { codex: 2 },
    };
    const { codex, session } = setup(() => [...replyWith("ok"), completed()], { record });
    await session.send("back to Codex");
    expect(codex.prompts[0]).toContain("While you were away");
    expect(codex.prompts[0]).toContain("User: then with Claude");
    expect(codex.prompts[0]).not.toContain("first, with Codex");
  });

  it("maps modes onto Codex's sandbox and approval policy, sent with every turn", async () => {
    expect(codexPolicy("plan", ROOT)).toMatchObject({ approvalPolicy: "never", sandbox: "read-only" });
    expect(codexPolicy("build", ROOT)).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: { writableRoots: [ROOT], networkAccess: false } });
    expect(codexPolicy("auto", ROOT)).toMatchObject({ approvalPolicy: "on-request" });
    const { codex, session } = setup(() => [...replyWith("ok"), completed()]);
    await session.send("one");
    await session.setMode("plan");
    await session.setModel("codex", "gpt-6-luna");
    await session.send("two");
    const turns = codex.requests.filter((request) => request.method === "turn/start").map((request) => request.params as Record<string, unknown>);
    expect(turns[0]).toMatchObject({ approvalPolicy: "untrusted" });
    expect(turns[1]).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, model: "gpt-6-luna" });
    expect(session.info()).toMatchObject({ provider: "codex", model: "gpt-6-luna", mode: "plan" });
  });

  it("says why Codex did not start", async () => {
    const { codex, session } = setup(() => []);
    codex.failInitialize = "not logged in";
    await expect(session.open()).rejects.toThrow(/Codex did not start: not logged in fake stderr line/);
  });

  it("answers the session commands it can, and says which it cannot", async () => {
    const { session } = setup(() => [{ notify: "turn/plan/updated", params: { plan: [{ step: "read", status: "completed" }, { step: "fix", status: "inProgress" }] } }, ...replyWith("ok"), completed()]);
    await session.send("plan it");
    expect(await session.command("todos", "")).toEqual({ kind: "todos", items: [{ text: "read", status: "done" }, { text: "fix", status: "in_progress" }] });
    expect(await session.command("cost", "")).toMatchObject({ kind: "text", text: expect.stringContaining("1 model calls, 100 input tokens (40 cached), 10 output") });
    expect(await session.command("undo", "")).toEqual({ kind: "text", text: "Nothing to undo." }); // no repository, no checkpoints
    expect(await session.command("undo", "conversation")).toMatchObject({ text: expect.stringContaining("Codex keeps its conversation") });
    expect(await session.command("review", "")).toMatchObject({ kind: "error" });
  });
});
