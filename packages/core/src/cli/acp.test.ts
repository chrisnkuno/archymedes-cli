import { describe, expect, it } from "vitest";
import {
  ACP_PROTOCOL_VERSION,
  AcpConnection,
  acpPermissionOptions,
  acpStopReason,
  acpToolKind,
  acpUpdateFor,
  ARCHYMEDES_ASK_METHOD,
  ARCHYMEDES_EVENT_METHOD,
  ARCHYMEDES_EVENTS_VERSION,
  archymedesEventForClient,
  decisionFromOptionId,
  JSON_RPC,
  toolCallTitle,
  type AcpApprovalRequest,
  type AcpSession,
  type JsonRpcOutgoing,
} from "./acp";
import type { ArchymedesEvent } from "./agent";

function connect(overrides: { onSend?: (prompt: string) => void; status?: "completed" | "cancelled" | "blocked" | "iteration_limit" } = {}) {
  const sent: JsonRpcOutgoing[] = [];
  let emit: ((event: ArchymedesEvent) => void) | undefined;
  let ask: ((request: { toolName: string; summary: string; toolCallId: string }) => Promise<string>) | undefined;
  const disposed: string[] = [];
  const modes: string[] = [];
  let cancelled = false;

  const connection = new AcpConnection({
    send: (message) => sent.push(message),
    createSession: async ({ onEvent, approve }) => {
      emit = onEvent;
      ask = approve;
      const session: AcpSession = {
        id: "sess_1",
        async send(prompt) {
          overrides.onSend?.(prompt);
          return { status: overrides.status ?? "completed", summary: "done" };
        },
        cancel() { cancelled = true; },
        async setMode(mode) { modes.push(mode); },
        async dispose() { disposed.push("sess_1"); },
      };
      return session;
    },
  });

  const call = async (method: string, params?: Record<string, unknown>, id: number | string = 1) => {
    await connection.receive({ jsonrpc: "2.0", id, method, params });
    return sent.find((message) => "id" in message && message.id === id && ("result" in message || "error" in message));
  };
  const notify = (method: string, params?: Record<string, unknown>) => connection.receive({ jsonrpc: "2.0", method, params });

  return { connection, sent, call, notify, emit: (event: ArchymedesEvent) => emit?.(event), ask: () => ask, disposed, modes, wasCancelled: () => cancelled };
}

const initialize = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} };

describe("acp handshake and sessions", () => {
  it("answers initialize with the version it speaks and what it can do", async () => {
    const value = connect();
    const response = await value.call("initialize", initialize);
    expect(response).toMatchObject({ result: { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: { loadSession: true } } });
  });

  it("refuses to create a session before the handshake", async () => {
    const value = connect();
    const response = await value.call("session/new", { cwd: "/tmp/project" });
    expect(response).toMatchObject({ error: { code: JSON_RPC.invalidRequest } });
  });

  it("names its modes so a client can offer them", async () => {
    const value = connect();
    await value.call("initialize", initialize);
    const response = await value.call("session/new", { cwd: "/tmp/project" }, 2);
    expect(response).toMatchObject({ result: { sessionId: "sess_1" } });

    await value.call("session/set_mode", { sessionId: "sess_1", modeId: "plan" }, 3);
    expect(value.modes).toEqual(["plan"]);
    const rejected = await value.call("session/set_mode", { sessionId: "sess_1", modeId: "godmode" }, 4);
    expect(rejected).toMatchObject({ error: { code: JSON_RPC.invalidParams } });
  });

  it("rejects work for a session that does not exist, rather than inventing one", async () => {
    const value = connect();
    await value.call("initialize", initialize);
    const response = await value.call("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] }, 2);
    expect(response).toMatchObject({ error: { code: JSON_RPC.invalidParams } });
  });

  it("answers unknown methods with method-not-found instead of failing the connection", async () => {
    const value = connect();
    const response = await value.call("session/teleport", {});
    expect(response).toMatchObject({ error: { code: JSON_RPC.methodNotFound } });
  });

  it("never replies to a notification, and cancels the session a cancel names", async () => {
    const value = connect();
    await value.call("initialize", initialize);
    await value.call("session/new", { cwd: "/tmp/project" }, 2);
    const before = value.sent.length;
    await value.notify("session/cancel", { sessionId: "sess_1" });
    await value.notify("session/cancel", { sessionId: "unknown" });

    expect(value.sent).toHaveLength(before);
    expect(value.wasCancelled()).toBe(true);
  });
});

describe("acp prompt turns", () => {
  async function ready(overrides: Parameters<typeof connect>[0] = {}) {
    const value = connect(overrides);
    await value.call("initialize", initialize);
    await value.call("session/new", { cwd: "/tmp/project" }, 2);
    return value;
  }

  it("flattens content blocks — including an attached resource — into the prompt the agent runs", async () => {
    const prompts: string[] = [];
    const value = await ready({ onSend: (prompt) => prompts.push(prompt) });
    await value.call("session/prompt", {
      sessionId: "sess_1",
      prompt: [
        { type: "text", text: "why does this fail?" },
        { type: "resource", resource: { uri: "file:///project/main.py", text: "def f(): pass" } },
        { type: "resource_link", uri: "file:///project/README.md" },
      ],
    }, 3);

    expect(prompts[0]).toContain("why does this fail?");
    expect(prompts[0]).toContain("def f(): pass");
    expect(prompts[0]).toContain("file:///project/README.md");
  });

  it("refuses an empty prompt rather than spending a model call on nothing", async () => {
    const value = await ready();
    const response = await value.call("session/prompt", { sessionId: "sess_1", prompt: [] }, 3);
    expect(response).toMatchObject({ error: { code: JSON_RPC.invalidParams } });
  });

  it("reports every terminal status as one of the protocol's stop reasons", async () => {
    expect(acpStopReason("completed")).toBe("end_turn");
    expect(acpStopReason("needs_verification")).toBe("end_turn");
    expect(acpStopReason("failed")).toBe("end_turn");
    expect(acpStopReason("needs_approval")).toBe("end_turn");
    expect(acpStopReason("cancelled")).toBe("cancelled");
    expect(acpStopReason("blocked")).toBe("refusal");
    expect(acpStopReason("iteration_limit")).toBe("max_turn_requests");
  });

  it("streams a turn's events as session/update notifications on the same session", async () => {
    const value = await ready();
    value.emit({ type: "runtime", event: { type: "assistant_delta", iteration: 1, text: "Looking..." } });
    value.emit({ type: "runtime", event: { type: "tool_call", toolCallId: "c1", toolName: "edit_file", effect: "workspace", arguments: { path: "src/app.ts" } } });
    value.emit({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "edit_file", isError: false, effect: "workspace", content: "1 replacement" } });
    // Local bookkeeping an editor cannot act on stays out of the client's transcript.
    value.emit({ type: "compaction", tokensBefore: 0, messagesBefore: 40, messagesAfter: 8 });

    const updates = value.sent.filter((message): message is Extract<JsonRpcOutgoing, { method: string }> => "method" in message && message.method === "session/update");
    expect(updates.map((update) => (update.params?.update as { sessionUpdate: string }).sessionUpdate)).toEqual(["agent_message_chunk", "tool_call", "tool_call_update"]);
    expect(updates.every((update) => update.params?.sessionId === "sess_1")).toBe(true);
  });
});

describe("acp permission requests", () => {
  it("asks the client, and treats anything that is not an explicit allow as a refusal", async () => {
    const answers: Record<string, unknown> = {
      "archymedes-1": { outcome: "selected", selectedOptionId: "allow" },
      "archymedes-2": { outcome: "selected", selectedOptionId: "allow_always" },
      "archymedes-3": { outcome: "cancelled" },
      "archymedes-4": { outcome: "selected", selectedOptionId: "something_else" },
    };
    const sent: JsonRpcOutgoing[] = [];
    let ask: ((request: { toolName: string; summary: string; toolCallId: string }) => Promise<string>) | undefined;
    const connection = new AcpConnection({
      send: (message) => {
        sent.push(message);
        // Stand in for the editor: answer every request the agent makes as soon as it makes it.
        if ("method" in message && message.method === "session/request_permission" && message.id !== undefined) {
          void connection.receive({ jsonrpc: "2.0", id: message.id, result: answers[String(message.id)] });
        }
      },
      createSession: async ({ approve }) => {
        ask = approve;
        return { id: "sess_1", async send() { return { status: "completed" as const, summary: "" }; }, cancel() {}, async setMode() {}, async dispose() {} };
      },
    });
    await connection.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize });
    await connection.receive({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp/p" } });

    const decisions = [];
    for (const toolName of ["write_file", "run_command", "run_command", "write_file"]) {
      decisions.push(await ask!({ toolName, summary: `${toolName} something`, toolCallId: "c1" }));
    }
    expect(decisions).toEqual(["allow", "allow_always", "deny", "deny"]);

    const request = sent.find((message) => "method" in message && message.method === "session/request_permission");
    expect(request).toMatchObject({ params: { sessionId: "sess_1", toolCall: { kind: "edit", status: "pending" } } });
    expect((request as unknown as { params: { options: Array<{ optionId: string }> } }).params.options.map((option) => option.optionId))
      .toEqual(["allow", "allow_always", "deny", "deny_always"]);
  });

  it("offers questions only to a client that opted in, and reads its answer back", async () => {
    const replies: unknown[] = [{ answer: "Use Postgres" }, { dismissed: true }];
    async function open(clientCapabilities: Record<string, unknown>) {
      const sent: JsonRpcOutgoing[] = [];
      let ask: ((question: { question: string; options: string[]; multiSelect: boolean }) => Promise<string | null>) | undefined;
      const connection = new AcpConnection({
        send: (message) => {
          sent.push(message);
          if ("method" in message && message.method === ARCHYMEDES_ASK_METHOD && message.id !== undefined) {
            void connection.receive({ jsonrpc: "2.0", id: message.id, result: replies.shift() as never });
          }
        },
        createSession: async (input) => {
          ask = input.ask;
          return { id: "sess_1", async send() { return { status: "completed" as const, summary: "" }; }, cancel() {}, async setMode() {}, async dispose() {} };
        },
      });
      await connection.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { ...initialize, clientCapabilities } });
      await connection.receive({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp/p" } });
      return { sent, ask };
    }

    expect((await open({})).ask).toBeUndefined();
    const { sent, ask } = await open({ _meta: { archymedes: { questions: true } } });
    expect(await ask!({ question: "Which database?", options: ["Postgres", "SQLite"], multiSelect: false })).toBe("Use Postgres");
    expect(await ask!({ question: "Name?", options: [], multiSelect: false })).toBeNull();
    expect(sent.find((message) => "method" in message && message.method === ARCHYMEDES_ASK_METHOD))
      .toMatchObject({ params: { sessionId: "sess_1", question: "Which database?", options: ["Postgres", "SQLite"], multiSelect: false } });
  });

  it("reads an unknown option id as a denial", () => {
    expect(decisionFromOptionId("allow")).toBe("allow");
    expect(decisionFromOptionId("allow_always")).toBe("allow_always");
    expect(decisionFromOptionId("deny_always")).toBe("deny_always");
    expect(decisionFromOptionId(undefined)).toBe("deny");
    expect(decisionFromOptionId("yes please")).toBe("deny");
    expect(decisionFromOptionId(42)).toBe("deny");
  });

  it("only honours allow_pattern when the request offered a pattern", () => {
    expect(decisionFromOptionId("allow_pattern")).toBe("deny");
    expect(decisionFromOptionId("allow_pattern", true)).toBe("allow_pattern");
    expect(acpPermissionOptions().map((option) => option.optionId)).toEqual(["allow", "allow_always", "deny", "deny_always"]);
    expect(acpPermissionOptions({ kind: "command-prefix", prefix: "npm test", label: "always allow commands starting with \"npm test\"" })[2])
      .toEqual({ optionId: "allow_pattern", name: "Always allow commands starting with \"npm test\"", kind: "allow_always" });
  });

  it("offers the pattern option to the client and round-trips allow_pattern", async () => {
    const sent: JsonRpcOutgoing[] = [];
    let ask: ((request: AcpApprovalRequest) => Promise<string>) | undefined;
    const connection = new AcpConnection({
      send: (message) => {
        sent.push(message);
        if ("method" in message && message.method === "session/request_permission" && message.id !== undefined) {
          void connection.receive({ jsonrpc: "2.0", id: message.id, result: { outcome: "selected", selectedOptionId: "allow_pattern" } });
        }
      },
      createSession: async ({ approve }) => {
        ask = approve;
        return { id: "sess_1", async send() { return { status: "completed" as const, summary: "" }; }, cancel() {}, async setMode() {}, async dispose() {} };
      },
    });
    await connection.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize });
    await connection.receive({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp/p" } });

    const pattern = { kind: "directory" as const, directory: "src/app", label: "always allow edits under src/app/" };
    expect(await ask!({ toolName: "edit_file", summary: "edit src/app/a.ts", toolCallId: "c1", pattern })).toBe("allow_pattern");
    // The same answer to a request that offered no pattern is not consent to anything.
    expect(await ask!({ toolName: "edit_file", summary: "edit src/app/a.ts", toolCallId: "c2" })).toBe("deny");

    const requests = sent.filter((message) => "method" in message && message.method === "session/request_permission") as unknown as Array<{ params: { options: Array<{ optionId: string; name: string }> } }>;
    expect(requests[0]!.params.options.map((option) => option.optionId)).toEqual(["allow", "allow_always", "allow_pattern", "deny", "deny_always"]);
    expect(requests[0]!.params.options[2]!.name).toBe("Always allow edits under src/app/");
    expect(requests[1]!.params.options.map((option) => option.optionId)).not.toContain("allow_pattern");
  });
});

describe("acp rendering hints", () => {
  it("classifies tools by what they do to the world, and unknown ones safely", () => {
    expect(acpToolKind("read_file")).toBe("read");
    expect(acpToolKind("edit_file")).toBe("edit");
    expect(acpToolKind("run_command")).toBe("execute");
    expect(acpToolKind("grep_files")).toBe("search");
    expect(acpToolKind("web_fetch")).toBe("fetch");
    expect(acpToolKind("todo_write")).toBe("think");
    expect(acpToolKind("some_mcp_tool")).toBe("other");
  });

  it("titles a call by the work, not by the function name", () => {
    expect(toolCallTitle("edit_file", { path: "src/app.ts" })).toBe("edit file: src/app.ts");
    expect(toolCallTitle("run_command", { command: "bun test" })).toBe("run command: bun test");
    expect(toolCallTitle("todo_read", {})).toBe("todo read");
    expect(toolCallTitle("read_file", { path: "x".repeat(400) }).length).toBeLessThan(140);
  });

  it("passes a failed tool through as a failed call, keeping its output", () => {
    const update = acpUpdateFor({ type: "runtime", event: { type: "tool_result", toolCallId: "c9", toolName: "run_command", isError: true, effect: "none", content: "exit 1: tests failed" } });
    expect(update).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "c9", status: "failed" });
    expect(JSON.stringify(update)).toContain("tests failed");
  });
});

describe("acp archymedes event extension", () => {
  const rich = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { _meta: { archymedes: { events: true } } } };
  const modelTurn: ArchymedesEvent = {
    type: "runtime",
    event: { type: "model_turn", iteration: 1, responseId: "r1", model: "m", toolCallCount: 0, usage: { inputTokens: 10, outputTokens: 5 } as never },
  };

  it("sends nothing extra to a client that did not opt in", async () => {
    const value = connect();
    const response = await value.call("initialize", initialize);
    expect(JSON.stringify(response)).not.toContain("archymedes");
    await value.call("session/new", { cwd: "/tmp/project" }, 2);
    value.emit(modelTurn);
    expect(value.sent.some((message) => "method" in message && message.method === ARCHYMEDES_EVENT_METHOD)).toBe(false);
  });

  it("streams every event but assistant text to a client that opted in", async () => {
    const value = connect();
    const response = await value.call("initialize", rich);
    expect(response).toMatchObject({ result: { agentCapabilities: { _meta: { archymedes: { events: ARCHYMEDES_EVENTS_VERSION } } } } });
    await value.call("session/new", { cwd: "/tmp/project" }, 2);
    value.emit({ type: "runtime", event: { type: "assistant_delta", iteration: 1, text: "hi" } });
    value.emit(modelTurn);
    value.emit({ type: "compaction", tokensBefore: 100, messagesBefore: 9, messagesAfter: 3 });
    const extended = value.sent.filter((message) => "method" in message && message.method === ARCHYMEDES_EVENT_METHOD);
    expect(extended.map((message) => ("params" in message ? (message.params?.event as { type: string }).type : ""))).toEqual(["runtime", "compaction"]);
    expect(extended[0]).toMatchObject({ params: { sessionId: "sess_1", event: { event: { type: "model_turn", responseId: "r1" } } } });
  });

  it("bounds tool output on the extension the way the journal does", () => {
    const huge = "x".repeat(200_000); // token-shaped on purpose: the run the redaction once scanned quadratically
    const event = archymedesEventForClient({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, effect: "none", content: huge } });
    expect(event && event.type === "runtime" && event.event.type === "tool_result" ? event.event.content.length : 0).toBeLessThan(huge.length);
    expect(archymedesEventForClient({ type: "runtime", event: { type: "assistant_delta", iteration: 1, text: "x" } })).toBeNull();
  });
});

describe("acp end of input", () => {
  it("reads a permission request the client can no longer answer as a refusal", async () => {
    const value = connect();
    await value.call("initialize", initialize);
    await value.call("session/new", { cwd: "/tmp/project" }, 2);
    const decision = value.ask()?.({ toolName: "run_command", summary: "run ls", toolCallId: "c1" });
    value.connection.endOfInput();
    await expect(decision).resolves.toBe("deny");
  });
});

describe("acp session/load replay", () => {
  it("sends the stored conversation before answering, and tool calls on the extension", async () => {
    const sent: JsonRpcOutgoing[] = [];
    const connection = new AcpConnection({
      send: (message) => sent.push(message),
      createSession: async () => ({
        id: "sess_9",
        send: async () => ({ status: "completed", summary: "" }),
        cancel() {},
        async setMode() {},
        async dispose() {},
        info: () => ({ sessionId: "sess_9" }),
        history: () => [
          { role: "system", content: "never shown" },
          { role: "user", content: "fix it" },
          { role: "assistant", content: "Looking.", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.ts" } }] },
          { role: "tool", content: "x", toolCallId: "c1", name: "read_file" },
          { role: "assistant", content: "internal note", internal: true },
          { role: "assistant", content: "Done." },
        ],
      }),
    });
    await connection.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { _meta: { archymedes: { events: true } } } } });
    await connection.receive({ jsonrpc: "2.0", id: 2, method: "session/load", params: { cwd: "/tmp", sessionId: "latest" } });
    const after = sent.slice(1);
    const reply = after.findIndex((message) => "id" in message && message.id === 2);
    expect(reply).toBe(after.length - 1); // history first, then the answer
    expect(after[reply]).toMatchObject({ result: { _meta: { archymedes: { sessionId: "sess_9" } } } });
    const shapes = after.slice(0, reply).map((message) => {
      const params = (message as { params: Record<string, any> }).params;
      return params.update?.sessionUpdate ?? params.event?.event?.type;
    });
    expect(shapes).toEqual(["user_message_chunk", "agent_message_chunk", "tool_call", "tool_call", "tool_call_update", "tool_result", "agent_message_chunk"]);
    expect(JSON.stringify(after)).not.toContain("never shown");
    expect(JSON.stringify(after)).not.toContain("internal note");
  });
});

describe("acp extension requests", () => {
  it("answers _archymedes requests after initialize, before any session, and nothing else", async () => {
    const sent: JsonRpcOutgoing[] = [];
    const connection = new AcpConnection({
      send: (message) => sent.push(message),
      createSession: async () => { throw new Error("no session needed"); },
      extensions: { "_archymedes/setup/status": async () => ({ configured: false }) },
    });
    await connection.receive({ jsonrpc: "2.0", id: 1, method: "_archymedes/setup/status", params: {} });
    expect(sent.at(-1)).toMatchObject({ id: 1, error: { code: JSON_RPC.invalidRequest } });
    await connection.receive({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await connection.receive({ jsonrpc: "2.0", id: 3, method: "_archymedes/setup/status", params: {} });
    expect(sent.at(-1)).toMatchObject({ id: 3, result: { configured: false } });
    await connection.receive({ jsonrpc: "2.0", id: 4, method: "_archymedes/unknown", params: {} });
    expect(sent.at(-1)).toMatchObject({ id: 4, error: { code: JSON_RPC.methodNotFound } });
  });
});

describe("acp model switching", () => {
  it("switches through the session and answers with its new info; a refused model is an error", async () => {
    const sent: JsonRpcOutgoing[] = [];
    let current = "m1";
    const connection = new AcpConnection({
      send: (message) => sent.push(message),
      createSession: async () => ({
        id: "sess_1", send: async () => ({ status: "completed", summary: "" }), cancel() {}, async setMode() {}, async dispose() {},
        async setModel(provider, model) {
          if (model === "nope") throw new Error(`No model ${model} at ${provider}`);
          current = model ?? "default";
        },
        info: () => ({ model: current }),
      }),
    });
    await connection.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { _meta: { archymedes: { events: true } } } } });
    await connection.receive({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
    await connection.receive({ jsonrpc: "2.0", id: 3, method: "_archymedes/session/set_model", params: { sessionId: "sess_1", provider: "anthropic", model: "m2" } });
    expect(sent.at(-1)).toMatchObject({ id: 3, result: { _meta: { archymedes: { model: "m2" } } } });
    await connection.receive({ jsonrpc: "2.0", id: 4, method: "_archymedes/session/set_model", params: { sessionId: "sess_1", provider: "anthropic", model: "nope" } });
    expect(sent.at(-1)).toMatchObject({ id: 4, error: { message: expect.stringContaining("No model nope") } });
    expect(current).toBe("m2");
  });

  it("hands a steer to the session and says whether it was taken; a session that cannot steer says no", async () => {
    const sent: JsonRpcOutgoing[] = [];
    const steered: string[] = [];
    let steerable = true;
    const connection = new AcpConnection({
      send: (message) => sent.push(message),
      createSession: async () => ({
        id: "sess_1", send: async () => ({ status: "completed", summary: "" }), cancel() {}, async setMode() {}, async dispose() {},
        ...(steerable ? { steer: (text: string) => { steered.push(text); return true; } } : {}),
      }),
    });
    await connection.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await connection.receive({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp" } });
    await connection.receive({ jsonrpc: "2.0", id: 3, method: "_archymedes/session/steer", params: { sessionId: "sess_1", text: "use tabs" } });
    expect(sent.at(-1)).toMatchObject({ id: 3, result: { accepted: true } });
    expect(steered).toEqual(["use tabs"]);
    await connection.receive({ jsonrpc: "2.0", id: 4, method: "_archymedes/session/steer", params: { sessionId: "sess_1" } });
    expect(sent.at(-1)).toMatchObject({ id: 4, error: { message: "text is required" } });
    steerable = false;
    await connection.receive({ jsonrpc: "2.0", id: 5, method: "session/new", params: { cwd: "/tmp" } });
    await connection.receive({ jsonrpc: "2.0", id: 6, method: "_archymedes/session/steer", params: { sessionId: "sess_1", text: "x" } });
    expect(sent.at(-1)).toMatchObject({ id: 6, result: { accepted: false } });
  });
});
