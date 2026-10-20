import { describe, expect, it } from "vitest";
import type { ArchymedesEvent } from "@archymedes/core/cli/agent";
import type { ArchymedesMode, PermissionDecision } from "@archymedes/core/cli/permissions";
import type { CommandRule } from "@archymedes/core/cli/command-rules";
import type { SessionRecord } from "@archymedes/core/cli/session";
import type { AcpApprovalRequest } from "@archymedes/core/cli/acp";
import type { ClaudeOptions, ClaudeSdk, PermissionMode, PermissionResult, Query, SdkMessage, SdkUserMessage } from "./sdk";
import { askUserQuestion, ClaudeSession, InputQueue, MAX_PREFACE_CHARS, prefaceFrom } from "./session";

const ROOT = "/work/project";

/** One step of a scripted reply: a message, a permission question, a wait for interrupt, or a crash. */
type Step = SdkMessage | { ask: { tool: string; input: Record<string, unknown>; id: string } } | { hang: true } | { crash: string };
type Script = (prompt: string, call: number) => Step[];
type Ask = { ask: { tool: string; input: Record<string, unknown>; id: string } };
const isAsk = (step: Step): step is Ask => "ask" in step && typeof step.ask === "object";
const isCrash = (step: Step): step is { crash: string } => "crash" in step && typeof step.crash === "string";

const reply = (text: string, sessionId = "s-1"): Step[] => [
  { type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5-5", tools: ["Read", "Edit", "Bash"] },
  { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: `m-${text}`, usage: { input_tokens: 3 } } } },
  { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
  { type: "assistant", parent_tool_use_id: null, message: { id: `m-${text}`, content: [{ type: "text", text }] } },
  { type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { input_tokens: 3, output_tokens: 2 } } },
  { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } },
];
const done = (sessionId = "s-1"): SdkMessage => ({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, total_cost_usd: 0.02, usage: { input_tokens: 3, output_tokens: 2 }, session_id: sessionId });
const toolUse = (id: string, name: string, input: Record<string, unknown>): SdkMessage => ({ type: "assistant", parent_tool_use_id: null, message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } });
const toolDone = (id: string, text = "ok"): SdkMessage => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });

/** A stand-in for the SDK and the Claude Code process behind it, driven by a script. */
class FakeClaude {
  startups: ClaudeOptions[] = [];
  queries: FakeQuery[] = [];
  prompts: SdkUserMessage[] = [];
  permissions: PermissionResult[] = [];
  failStartup: (options: ClaudeOptions) => string | undefined = () => undefined;
  constructor(public script: Script) {}

  readonly sdk: ClaudeSdk = {
    startup: async ({ options }) => {
      this.startups.push(options);
      const failure = this.failStartup(options);
      if (failure) {
        options.stderr?.("Error: something on stderr\n");
        throw new Error(failure);
      }
      return { query: (input) => { const query = new FakeQuery(this, options, input); this.queries.push(query); return query; }, close: () => undefined };
    },
  };
}

class FakeQuery implements Query {
  readonly output = new InputQueue<SdkMessage>();
  interrupts = 0;
  modes: PermissionMode[] = [];
  models: Array<string | undefined> = [];
  rewinds: Array<{ id: string; dryRun: boolean }> = [];
  closed = false;
  private interrupted?: () => void;
  private failure?: Error;

  constructor(private readonly claude: FakeClaude, private readonly options: ClaudeOptions, input: AsyncIterable<SdkUserMessage>) {
    void this.pump(input);
  }

  private async pump(input: AsyncIterable<SdkUserMessage>): Promise<void> {
    let call = 0;
    for await (const message of input) {
      this.claude.prompts.push(message);
      const steps = this.claude.script(message.message.content, call++);
      let crashed = false;
      for (const step of steps) {
        if (isAsk(step)) {
          const { ask } = step;
          const answer = await this.options.canUseTool(ask.tool, ask.input, { signal: new AbortController().signal, toolUseID: ask.id, suggestions: [{ type: "addRules", destination: "localSettings" }] });
          this.claude.permissions.push(answer);
        } else if ("hang" in step) {
          await new Promise<void>((resolve) => { this.interrupted = resolve; });
          if (this.closed) break;
          this.output.push({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, total_cost_usd: 0, usage: {}, session_id: "s-1" });
        } else if (isCrash(step)) {
          this.failure = new Error(step.crash);
          crashed = true;
          break;
        } else if (!this.closed) this.output.push(step);
      }
      if (crashed) break;
    }
    this.output.end();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SdkMessage> {
    for await (const message of this.output) yield message;
    if (this.failure) throw this.failure;
  }

  async interrupt() { this.interrupts += 1; this.interrupted?.(); this.interrupted = undefined; return undefined; }
  async setPermissionMode(mode: PermissionMode) { this.modes.push(mode); }
  async setModel(model?: string) { this.models.push(model); }
  async supportedModels() { return [{ value: "default", displayName: "Default", description: "" }, { value: "opus", displayName: "Opus", description: "" }]; }
  async rewindFiles(id: string, options?: { dryRun?: boolean }) { this.rewinds.push({ id, dryRun: options?.dryRun === true }); return { canRewind: true, filesChanged: ["/work/project/a.ts"] }; }
  close() { this.closed = true; this.output.end(); }
}

function setup(script: Script, options: { record?: SessionRecord; decisions?: PermissionDecision[]; model?: string; mode?: ArchymedesMode; rules?: CommandRule[]; testFirst?: boolean } = {}) {
  const claude = new FakeClaude(script);
  const events: ArchymedesEvent[] = [];
  const saved: SessionRecord[] = [];
  const asked: AcpApprovalRequest[] = [];
  const decisions = [...(options.decisions ?? [])];
  const models: string[][] = [];
  const session = new ClaudeSession({
    root: ROOT, sdk: claude.sdk, executable: "/usr/local/bin/claude", environment: { PATH: "/usr/bin" }, mode: options.mode ?? "build",
    commandRules: async () => options.rules ?? [],
    ...(options.model ? { model: options.model } : {}),
    ...(options.record ? { record: options.record } : {}),
    onEvent: (event) => events.push(event),
    approve: async (request) => { asked.push(request); return decisions.shift() ?? "deny"; },
    save: async (record) => { saved.push(structuredClone(record)); },
    onModels: (list) => models.push(list),
    ...(options.testFirst !== undefined ? { testFirst: options.testFirst } : {}),
  });
  return { claude, session, events, saved, asked, models };
}

const stops = (events: ArchymedesEvent[]) => events.filter((event) => event.type === "runtime" && event.event.type === "runtime_stop");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ClaudeSession", () => {
  it("starts Claude Code when the session opens, and every turn reuses that one process", async () => {
    const { claude, session, events, models } = setup((prompt) => [...reply(`re: ${prompt}`), done()]);
    await session.open();
    expect(claude.startups).toHaveLength(1);
    expect(claude.startups[0]).toMatchObject({
      cwd: ROOT, pathToClaudeCodeExecutable: "/usr/local/bin/claude", env: { PATH: "/usr/bin" }, permissionMode: "default",
      includePartialMessages: true, enableFileCheckpointing: true, systemPrompt: { type: "preset", preset: "claude_code" },
    });
    expect(claude.startups[0]).not.toHaveProperty("model");
    expect(await session.send("one")).toEqual({ status: "completed", summary: "ok" });
    expect(await session.send("two")).toMatchObject({ status: "completed" });
    expect(claude.startups).toHaveLength(1);
    expect(stops(events)).toHaveLength(2);
    expect(models).toEqual([["default", "opus"]]);
    expect(session.info()).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", mode: "build", workspace: "local" });
  });

  it("tells Claude Code to build test first when that is on, on top of its own prompt", async () => {
    const { claude, session } = setup((prompt) => [...reply(`re: ${prompt}`), done()], { testFirst: true });
    await session.open();
    const prompt = (claude.startups[0] as { systemPrompt: { preset: string; append?: string } }).systemPrompt;
    expect(prompt.preset).toBe("claude_code");
    expect(prompt.append).toMatch(/Build test first/);
    expect(prompt.append).toMatch(/static analysis/);
  });

  it("saves each turn as an Friday session that knows Claude's own session id", async () => {
    const { session, saved } = setup((prompt) => [...reply(`re: ${prompt}`), done("claude-abc")]);
    await session.send("Fix the failing test");
    const record = saved.at(-1)!;
    expect(record).toMatchObject({ id: session.id, title: "Fix the failing test", claudeSession: "claude-abc", modelSelection: { provider: "claude", model: "default" }, mode: "build" });
    expect(record.messages).toEqual([{ role: "user", content: "Fix the failing test" }, { role: "assistant", content: "re: Fix the failing test" }]);
    expect(session.snapshot()).toMatchObject({ id: session.id, claudeSession: "claude-abc" });
  });

  it("asks the person through Friday's approval, and keeps 'always' to this session", async () => {
    const script: Script = () => [
      toolUse("t1", "Bash", { command: "npm test" }), { ask: { tool: "Bash", input: { command: "npm test" }, id: "t1" } }, toolDone("t1"),
      toolUse("t2", "Edit", { file_path: `${ROOT}/a.ts`, old_string: "a", new_string: "b" }), { ask: { tool: "Edit", input: { file_path: `${ROOT}/a.ts` }, id: "t2" } }, toolDone("t2"),
      toolUse("t3", "mcp__docs__publish", { url: "https://x" }), { ask: { tool: "mcp__docs__publish", input: { url: "https://x" }, id: "t3" } }, toolDone("t3"),
      toolUse("t4", "mcp__docs__publish", { url: "https://y" }), { ask: { tool: "mcp__docs__publish", input: { url: "https://y" }, id: "t4" } }, toolDone("t4"),
      done(),
    ];
    const { claude, session, asked } = setup(script, { decisions: ["allow", "allow_always", "deny_always"] });
    await session.send("go");
    expect(asked.map((request) => [request.toolName, request.toolCallId, request.summary])).toEqual([
      ["run_command", "t1", "run command: npm test"], ["edit_file", "t2", "edit file: a.ts"], ["mcp__docs__publish", "t3", "mcp docs publish"],
    ]);
    expect(claude.permissions[0]).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    expect(claude.permissions[1]).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "addRules", destination: "session" }] });
    expect(claude.permissions[2]).toMatchObject({ behavior: "deny" });
    expect(claude.permissions[3]).toMatchObject({ behavior: "deny", message: expect.stringContaining("refused for the rest of this session") });
  });

  it("never asks about tools that change nothing, and in auto mode runs a command the safety screen passes", async () => {
    const script: Script = () => [
      toolUse("s1", "WebSearch", { query: "a" }), { ask: { tool: "WebSearch", input: { query: "a" }, id: "s1" } },
      toolUse("s2", "WebSearch", { query: "b" }), { ask: { tool: "WebSearch", input: { query: "b" }, id: "s2" } },
      toolUse("s3", "WebFetch", { url: "https://x" }), { ask: { tool: "WebFetch", input: { url: "https://x" }, id: "s3" } },
      toolDone("s1"), toolDone("s2"), toolDone("s3"),
      toolUse("b1", "Bash", { command: "npm test" }), { ask: { tool: "Bash", input: { command: "npm test" }, id: "b1" } }, toolDone("b1"),
      toolUse("b2", "Bash", { command: "rm -rf /tmp/x" }), { ask: { tool: "Bash", input: { command: "rm -rf /tmp/x" }, id: "b2" } }, toolDone("b2"),
      toolUse("b3", "Bash", { command: "ls", dangerouslyDisableSandbox: true }), { ask: { tool: "Bash", input: { command: "ls", dangerouslyDisableSandbox: true }, id: "b3" } }, toolDone("b3"),
      done(),
    ];
    const { claude, session, asked } = setup(script, { mode: "auto", decisions: ["allow", "allow"] });
    await session.send("research");
    expect(asked.map((request) => request.toolCallId)).toEqual(["b2", "b3"]);
    expect(claude.permissions.slice(0, 4)).toEqual([
      { behavior: "allow", updatedInput: { query: "a" } }, { behavior: "allow", updatedInput: { query: "b" } },
      { behavior: "allow", updatedInput: { url: "https://x" } }, { behavior: "allow", updatedInput: { command: "npm test" } },
    ]);
  });

  it("follows the person's command rules before asking, and asks about every command in build mode", async () => {
    const rules: CommandRule[] = [
      { prefix: ["npm", "run", "deploy"], decision: "forbid", reason: "deploys go through CI", source: "rules.json" },
      { prefix: ["make"], decision: "allow", source: "rules.json" },
    ];
    const script: Script = () => [
      toolUse("r1", "Bash", { command: "npm run deploy" }), { ask: { tool: "Bash", input: { command: "npm run deploy" }, id: "r1" } }, toolDone("r1"),
      toolUse("r2", "Bash", { command: "make" }), { ask: { tool: "Bash", input: { command: "make" }, id: "r2" } }, toolDone("r2"),
      toolUse("r3", "Bash", { command: "npm test" }), { ask: { tool: "Bash", input: { command: "npm test" }, id: "r3" } }, toolDone("r3"),
      done(),
    ];
    const { claude, session, asked } = setup(script, { rules, decisions: ["allow"] });
    await session.send("ship");
    expect(asked.map((request) => request.toolCallId)).toEqual(["r3"]);
    expect(claude.permissions[0]).toMatchObject({ behavior: "deny", message: expect.stringContaining("deploys go through CI") });
    expect(claude.permissions[1]).toMatchObject({ behavior: "allow" });
  });

  it("stops a turn by interrupting Claude Code, and closes the call that was running", async () => {
    const { claude, session, events } = setup(() => [toolUse("t1", "Bash", { command: "sleep 99" }), { hang: true }]);
    const turn = session.send("wait");
    await tick();
    session.cancel();
    session.cancel(); // twice is once
    expect(await turn).toEqual({ status: "cancelled", summary: "Stopped." });
    expect(claude.queries[0].interrupts).toBe(1);
    expect(events.filter((event) => event.type === "runtime" && event.event.type === "tool_result")).toMatchObject([{ event: { toolCallId: "t1", isError: true } }]);
  });

  it("ends a turn when Claude Code dies, and resumes the same Claude conversation on the next", async () => {
    const { claude, session } = setup((prompt, call) => (call === 0 && prompt === "first" ? [{ type: "system", subtype: "init", session_id: "s-9", model: "m", tools: [] }, { crash: "segfault" }] : [...reply("back"), done("s-9")]));
    const first = await session.send("first");
    expect(first.status).toBe("failed");
    expect(first.summary).toContain("Claude Code stopped: segfault");
    expect(await session.send("second")).toMatchObject({ status: "completed" });
    expect(claude.startups).toHaveLength(2);
    expect(claude.startups[1].resume).toBe("s-9");
  });

  it("tells Claude, once, what was said with another model before it took over", async () => {
    const record = storedRecord([{ role: "user", content: "What does main.go do?" }, { role: "assistant", content: "It starts the UI." }, { role: "user", content: "internal", internal: true }]);
    const { claude, session, saved } = setup((prompt) => [...reply("sure"), done()], { record });
    await session.send("Now add a flag");
    await session.send("And test it");
    expect(claude.prompts[0].message.content).toMatch(/^<earlier_conversation [^>]+>\nUser: What does main.go do\?\n\nAssistant: It starts the UI.\n<\/earlier_conversation>\n\nNow add a flag$/);
    expect(claude.prompts[1].message.content).toBe("And test it");
    expect(session.id).toBe("20261015T000000Z-abc123");
    expect(saved.at(-1)!.messages.map((message) => message.content)).toEqual(["What does main.go do?", "It starts the UI.", "internal", "Now add a flag", "sure", "And test it", "sure"]);
  });

  it("resumes Claude's own conversation, and starts a new one (told what was said) when it is gone", async () => {
    const record = { ...storedRecord([{ role: "user", content: "earlier" }, { role: "assistant", content: "answer" }]), claudeSession: "gone" };
    const { claude, session } = setup(() => [...reply("hi"), done("fresh")], { record });
    claude.failStartup = (options) => (options.resume === "gone" ? "No conversation found with session ID: gone" : undefined);
    await session.send("continue");
    expect(claude.startups.map((options) => options.resume)).toEqual(["gone", undefined]);
    expect(claude.prompts[0].message.content).toContain("User: earlier");
    expect(session.snapshot().claudeSession).toBe("fresh");
  });

  it("says why Claude Code did not start", async () => {
    const { claude, session } = setup(() => []);
    claude.failStartup = () => "spawn ENOENT";
    await expect(session.open()).rejects.toThrow("Claude Code did not start: spawn ENOENT (Error: something on stderr)");
  });

  it("undoes a turn by rewinding the files to the moment it was asked", async () => {
    const { claude, session } = setup(() => [...reply("edited"), done()]);
    await session.send("Rename the function");
    const id = claude.prompts[0].uuid;
    expect(await session.command("undo", "")).toEqual({ kind: "text", text: 'Put back the file Claude changed in "Rename the function". (Commands it ran are not undone.)' });
    expect(claude.queries[0].rewinds).toEqual([{ id, dryRun: true }, { id, dryRun: false }]);
    expect(await session.command("undo", "")).toEqual({ kind: "text", text: "Nothing to undo." });
    expect(await session.command("undo", "conversation")).toMatchObject({ kind: "text" });
    expect(await session.command("undo", "everything")).toMatchObject({ kind: "error" });
  });

  it("passes mode and model changes to the running process, and answers the session commands", async () => {
    const { claude, session } = setup(() => [...reply("x"), toolUse("t", "TodoWrite", { todos: [{ content: "a", status: "pending" }] }), toolDone("t"), done()], { model: "sonnet" });
    expect(claude.startups).toHaveLength(0);
    await session.setMode("plan"); // before the process exists: applied when it starts
    await session.send("plan it");
    expect(claude.startups[0]).toMatchObject({ permissionMode: "plan", model: "sonnet" });
    await session.setMode("auto");
    await session.setModel("claude", "opus");
    await session.setModel("claude", "default");
    expect(claude.queries[0].modes).toEqual(["acceptEdits"]);
    expect(claude.queries[0].models).toEqual(["opus", undefined]);
    expect(session.snapshot().modelSelection).toEqual({ provider: "claude", model: "default" });
    expect(await session.command("todos", "")).toEqual({ kind: "todos", items: [{ text: "a", status: "pending" }] });
    expect(await session.command("cost", "")).toMatchObject({ kind: "text", text: expect.stringContaining("Billed to your Claude plan") });
    expect(await session.command("tools", "")).toMatchObject({ kind: "text", text: expect.stringContaining("Edit") });
    expect(await session.command("wander", "")).toMatchObject({ kind: "error" });
  });

  it("refuses a second prompt while a turn runs, and closes the process on dispose", async () => {
    const { claude, session } = setup(() => [{ hang: true }]);
    const turn = session.send("long");
    await expect(session.send("again")).rejects.toThrow("already running");
    await session.dispose();
    expect(await turn).toMatchObject({ status: "cancelled" });
    expect(claude.queries[0].closed).toBe(true);
    await expect(session.send("after")).rejects.toThrow("closed");
  });
});

describe("steering Claude", () => {
  it("takes a message only while a tool runs, hands it to Claude Code, and keeps it in the transcript", async () => {
    // Claude Code reads a message sent mid-turn after the running tool and answers it in the same
    // turn: the fake gives that message no turn of its own.
    const { claude, session, saved } = setup((prompt) => (prompt.startsWith("use tabs") ? [] : [{ type: "system", subtype: "init", session_id: "s-1", model: "m", tools: [] }, toolUse("t1", "Bash", { command: "sleep 5" }), { hang: true }]));
    const turn = session.send("format the code");
    expect(session.steer("too soon")).toBe(false); // nothing running yet: it would come after the end
    for (let i = 0; i < 5; i += 1) await tick();
    expect(session.steer("use tabs, not spaces")).toBe(true);
    session.cancel();
    await turn;
    for (let i = 0; i < 5; i += 1) await tick(); // the fake reads its input one turn at a time
    expect(claude.prompts.map((prompt) => prompt.message.content)).toEqual(["format the code", "use tabs, not spaces"]);
    expect(session.steer("after the end")).toBe(false);
    expect(saved.at(-1)!.messages.map((message) => message.content)).toEqual(["format the code", "[Sent while you were working] use tabs, not spaces"]);
  });
});

describe("prefaceFrom", () => {
  it("keeps the newest of a long conversation, and says nothing for an empty one", () => {
    expect(prefaceFrom([])).toBe("");
    const long = Array.from({ length: 400 }, (_, index) => ({ role: (index % 2 ? "assistant" : "user") as "user" | "assistant", content: `message ${index} ${"x".repeat(100)}` }));
    const preface = prefaceFrom(long);
    expect(preface.length).toBeLessThan(MAX_PREFACE_CHARS + 300);
    expect(preface).toContain("message 399");
    expect(preface).not.toContain("message 0 ");
  });
});

function storedRecord(messages: SessionRecord["messages"]): SessionRecord {
  return { schemaVersion: 2, revision: 3, id: "20261015T000000Z-abc123", createdAt: 1, updatedAt: 2, root: ROOT, title: "Earlier", messages, approvals: {}, totalRwf: 0, modelSelection: { provider: "openai", model: "gpt" } };
}

/**
 * The session's invariants under a seeded random person and a seeded random Claude Code: prompts,
 * stops mid-turn, mode and model changes, undo, and replies that use tools, ask permission, hang
 * until interrupted or crash the process. Checked after every turn: it ended with exactly one stop,
 * nothing was said between turns, every call was closed, the process was started once plus once per
 * crash, and the saved transcript alternates as turns do. `SEED=<n> npx vitest run claude/session`.
 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("ClaudeSession invariants", () => {
  const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: 120 }, (_, index) => index + 1);
  it.each(seeds)("seed %i", async (seed) => {
    const next = random(seed);
    let crashes = 0;
    const script: Script = () => {
      const steps: Step[] = [...reply(`r${Math.floor(next() * 1000)}`)];
      for (let call = 0; call < Math.floor(next() * 3); call += 1) {
        const id = `t${Math.floor(next() * 1e9)}`;
        steps.push(toolUse(id, ["Bash", "Edit", "Read"][call % 3], { command: "x", file_path: `${ROOT}/a` }));
        if (next() < 0.5) steps.push({ ask: { tool: "Bash", input: {}, id } });
        if (next() < 0.8) steps.push(toolDone(id));
      }
      const end = next();
      if (end < 0.1) { crashes += 1; steps.push({ crash: "boom" }); } else if (end < 0.25) steps.push({ hang: true }); else steps.push(done());
      return steps;
    };
    const decisions: PermissionDecision[] = Array.from({ length: 50 }, () => (["allow", "allow_always", "deny", "deny_always"] as const)[Math.floor(next() * 4)]);
    const { claude, session, events, saved } = setup(script, { decisions });
    let turns = 0;
    for (let step = 0; step < 12; step += 1) {
      const op = next();
      if (op < 0.6) {
        const before = events.length;
        const pending = session.send(`prompt ${step}`);
        await tick();
        if (next() < 0.3) session.cancel();
        // A hung reply ends only when stopped: stop it if nobody did.
        const outcome = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5))]);
        if (outcome === null) session.cancel();
        const result = outcome ?? (await pending);
        turns += 1;
        const said = events.slice(before);
        expect(stops(said), `seed ${seed}: turn ${turns} stops`).toHaveLength(1);
        expect(said.at(-1)).toMatchObject({ type: "runtime", event: { type: "runtime_stop", status: result.status } });
        const calls = said.filter((event) => event.type === "runtime" && event.event.type === "tool_call").length;
        const answers = said.filter((event) => event.type === "runtime" && event.event.type === "tool_result").length;
        expect(answers, `seed ${seed}: open calls`).toBe(calls);
        expect(saved).toHaveLength(turns);
      } else if (op < 0.7) await session.setMode((["plan", "build", "auto", "defender"] as const)[Math.floor(next() * 4)]);
      else if (op < 0.8) await session.setModel("claude", ["opus", "sonnet", "default"][Math.floor(next() * 3)]);
      else if (op < 0.9) expect(["text", "error"]).toContain((await session.command("undo", "")).kind);
      else {
        const quiet = events.length;
        await tick();
        expect(events.length, `seed ${seed}: spoke between turns`).toBe(quiet);
      }
    }
    expect(claude.startups.length, `seed ${seed}: processes`).toBeLessThanOrEqual(1 + crashes);
    const messages = saved.at(-1)?.messages ?? [];
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].role === "assistant") expect(messages[index - 1]?.role, `seed ${seed}: assistant without a prompt`).toBe("user");
    }
    expect(messages.filter((message) => message.role === "user")).toHaveLength(turns);
    await session.dispose();
  });
});

describe("AskUserQuestion", () => {
  it("puts each question to the person and hands Claude Code the answers by question", async () => {
    const asked: unknown[] = [];
    const result = await askUserQuestion(async (question) => { asked.push(question); return "Postgres"; }, {
      questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "server" }, { label: "SQLite" }], multiSelect: false }],
    }, "tu_1");
    expect(asked).toEqual([{ question: "Which database?", options: ["Postgres", "SQLite"], multiSelect: false, toolCallId: "tu_1" }]);
    expect(result).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which database?": "Postgres" } } });
  });

  it("reads a dismissed question as a refusal, so Claude carries on", async () => {
    const result = await askUserQuestion(async () => null, { questions: [{ question: "Name?", options: [] }] }, "tu_2");
    expect(result).toMatchObject({ behavior: "deny" });
  });
});
