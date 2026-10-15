import { describe, expect, it } from "vitest";
import { BoundedAgentRuntime, type AgentMessage, type AgentModelRequest, type AgentModelTurn, type AgentRuntimeEvent, type AgentTool, type AgentToolCall } from "./agent-runtime";

/**
 * The agent runtime's invariants, checked against a model that misbehaves at random.
 *
 * The example tests in `agent-runtime.test.ts` each pin one story. This suite instead lets a
 * seeded random model do anything a real one has been seen to do (text, truncated text, refusals,
 * "too long for my context" (which the runtime answers by shortening the transcript),
 * tool calls with real, aliased, invented or malformed names, duplicate or empty ids, arguments that
 * are not objects, too many calls in one turn, retryable and fatal provider errors) and checks, on
 * every request the runtime sends and on every result it returns, the properties no story may
 * break. The most important: a provider is never sent a transcript it would reject, because every
 * tool call is answered exactly once, by name, before anything else is said.
 *
 * A failure names its seed, so it replays exactly: `SEED=<n> npx vitest run runtime-invariants`.
 */

/** mulberry32: small, fast and reproducible. */
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

const usage = { inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

/** Names a model might call: ours, ones `tool-aliases` translates, and ones nothing knows. */
const NAMES = ["read_file", "run_command", "write_file", "Bash", "Read", "functions.read_file", "container.exec", "search", "bogus_tool", "delete_everything"];

type Executed = { name: string; args: Record<string, unknown> };

function tools(executed: Executed[]): AgentTool[] {
  const tool = (name: string, capabilityId: string, effect: AgentTool["effect"], requiresApproval: boolean): AgentTool => ({
    name, description: name, inputSchema: { type: "object" }, capabilityId, effect, requiresApproval, parallelSafe: effect === "none",
    async execute(args) {
      expect(args !== null && typeof args === "object" && !Array.isArray(args), `${name} ran with arguments that are not an object`).toBe(true);
      executed.push({ name, args });
      return { content: `${name} ok` };
    },
  });
  return [
    tool("read_file", "workspace.files", "none", false),
    tool("write_file", "workspace.files", "workspace", true),
    tool("run_command", "workspace.terminal", "workspace", true),
    // Registered but outside every run's capabilities: it must never run.
    tool("deploy_app", "operations.execute", "external", true),
  ];
}

function randomArguments(next: () => number): unknown {
  const r = next();
  if (r < 0.55) return { path: "src/a.ts", command: "echo hi", file_path: "src/a.ts", cmd: ["bash", "-lc", "ls"], content: "x" };
  if (r < 0.7) return {};
  if (r < 0.8) return "not an object";
  if (r < 0.9) return ["an", "array"];
  return null;
}

function randomTurn(next: () => number, index: number): AgentModelTurn | Error {
  const base = { responseId: `r${index}`, model: "random", usage, content: "", toolCalls: [] as AgentToolCall[] };
  const r = next();
  if (r < 0.04) return Object.assign(new Error("service unavailable"), { status: 503 });
  if (r < 0.06) return Object.assign(new Error("bad request"), { status: 400 });
  if (r < 0.1) return Object.assign(new Error("This model's maximum context length is 8192 tokens"), { status: 400 });
  if (r < 0.18) return { ...base, finishReason: "stop", content: "Done." };
  if (r < 0.24) return { ...base, finishReason: "length", content: "and so on" };
  if (r < 0.27) return { ...base, finishReason: "refusal", content: "", refusal: "no" };
  if (r < 0.31) return { ...base, finishReason: "tool_calls", content: "" }; // declares calls, sends none
  const count = 1 + Math.floor(next() * 6); // up to 6: sometimes over the per-turn limit
  const toolCalls: AgentToolCall[] = [];
  for (let i = 0; i < count; i += 1) {
    const idRoll = next();
    const id = idRoll < 0.05 ? "" : idRoll < 0.1 && i > 0 ? toolCalls[0].id : `c${index}_${i}`;
    toolCalls.push({ id, name: NAMES[Math.floor(next() * NAMES.length)], arguments: randomArguments(next) });
  }
  return { ...base, finishReason: "tool_calls", content: next() < 0.5 ? "working" : "", toolCalls };
}

/** Every tool call is answered exactly once, in a contiguous run right after it, by its own name. */
function assertWellFormedTranscript(messages: readonly AgentMessage[], where: string) {
  expect(messages[0]?.role, `${where}: the transcript does not open with the system prompt`).toBe("system");
  const seenIds = new Set<string>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "tool") {
      throw new Error(`${where}: message ${i} answers ${message.toolCallId}, which no call just before it made`);
    }
    if (message.role !== "assistant" || !("toolCalls" in message)) continue;
    const pending = new Map(message.toolCalls.map((call) => [call.id, call.name]));
    expect(pending.size, `${where}: message ${i} has duplicate or empty call ids`).toBe(message.toolCalls.length);
    for (const call of message.toolCalls) {
      expect(call.id.trim(), `${where}: message ${i} has an empty call id`).not.toBe("");
      expect(seenIds.has(call.id), `${where}: call id ${call.id} is reused across turns`).toBe(false);
      seenIds.add(call.id);
    }
    let j = i + 1;
    for (; j < messages.length && messages[j].role === "tool"; j += 1) {
      const answer = messages[j] as Extract<AgentMessage, { role: "tool" }>;
      expect(pending.get(answer.toolCallId), `${where}: message ${j} answers ${answer.toolCallId} as ${answer.name}`).toBe(answer.name);
      pending.delete(answer.toolCallId);
    }
    expect([...pending.keys()], `${where}: calls left unanswered after message ${i}`).toEqual([]);
    i = j - 1;
  }
}

async function runSeed(seed: number, approve: boolean) {
  const next = random(seed);
  const executed: Executed[] = [];
  const events: AgentRuntimeEvent[] = [];
  const requests: AgentModelRequest[] = [];
  const returned: AgentModelTurn[] = [];
  const toolList = tools(executed);
  const runtime = new BoundedAgentRuntime({
    tools: toolList,
    prices: { inputRatePerMillion: 1, outputRatePerMillion: 1 },
    retry: { sleep: async () => true, random: () => 0 },
    model: {
      async complete(request) {
        requests.push(request);
        assertWellFormedTranscript(request.messages, `seed ${seed}, request ${requests.length}`);
        const names = request.tools.map((tool) => tool.name);
        expect(new Set(names).size, `seed ${seed}: duplicate tool definitions`).toBe(names.length);
        expect(names, `seed ${seed}: offered a tool outside the run's capabilities`).not.toContain("deploy_app");
        expect(request.maxOutputTokens).toBeGreaterThan(0);
        const outcome = randomTurn(next, requests.length);
        if (outcome instanceof Error) throw outcome;
        returned.push(outcome);
        return outcome;
      },
    },
    control: {
      async heartbeat() {},
      async isCancellationRequested() { return false; },
      async isToolCallApproved() { return approve; },
      async persistEvent(event) { events.push(event); },
    },
  });
  const request = {
    taskId: "t", runId: "r", stepId: "s", objective: "do the thing", systemPrompt: "system",
    history: seed % 3 === 0 ? [
      { role: "user" as const, content: "earlier" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: `h${seed}`, name: "read_file", arguments: { path: "old" } }] },
      { role: "tool" as const, content: "z".repeat(2_000), toolCallId: `h${seed}`, name: "read_file" },
      { role: "assistant" as const, content: "earlier answer" },
    ] : undefined,
    allowedCapabilityIds: ["workspace.files", "workspace.terminal"], maxIterations: 8, maxToolCalls: 10, maxToolCallsPerTurn: 4,
    maxToolResultChars: 500, maxTotalToolResultChars: 4_000, maxOutputTokens: 1_000, modelReservationRwf: 1_000_000, safetyIdentifier: "seed",
  };
  let result;
  try {
    result = await runtime.execute(request);
  } catch (error) {
    // The only way out other than a result: a provider error the runtime chose not to retry, or ran out of retries for.
    const status = (error as { status?: number; cause?: { status?: number } }).status ?? (error as { cause?: { status?: number } }).cause?.status;
    expect([400, 503], `seed ${seed}: threw ${String(error)}`).toContain(status);
    return { result: undefined, executed, events, requests, returned };
  }
  return { result, executed, events, requests, returned };
}

const SEEDS = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: 400 }, (_, i) => i + 1);

describe("agent runtime invariants under a random model", () => {
  it("never sends a provider a transcript it would reject, and never exceeds its bounds", async () => {
    for (const seed of SEEDS) {
      const { result, executed, events, requests, returned } = await runSeed(seed, true);
      expect(requests.length, `seed ${seed}: more model calls than iterations allow (with retries)`).toBeLessThanOrEqual(8 * 6);
      for (const run of executed) expect(["read_file", "write_file", "run_command"], `seed ${seed}: ran ${run.name}`).toContain(run.name);
      if (!result) continue;
      assertWellFormedTranscript(result.messages, `seed ${seed}, final transcript`);
      expect(result.toolCallsExecuted, `seed ${seed}`).toBeLessThanOrEqual(10);
      expect(result.iterations, `seed ${seed}`).toBeLessThanOrEqual(8);
      expect(result.toolCallsExecuted, `seed ${seed}: the count disagrees with what ran`).toBe(executed.length);
      // Usage is the sum of what the model reported, no more and no less.
      expect(result.usage.inputTokens, `seed ${seed}`).toBe(returned.length * usage.inputTokens);
      // Every announced tool call has its result, in order.
      const started = events.filter((event) => event.type === "tool_call").map((event) => (event as { toolCallId: string }).toolCallId);
      const finished = events.filter((event) => event.type === "tool_result").map((event) => (event as { toolCallId: string }).toolCallId);
      expect(finished.sort(), `seed ${seed}: a tool started without finishing`).toEqual(started.sort());
      // A translated name always runs as the tool it was translated to.
      for (const event of events) {
        if (event.type !== "tool_name" || !event.resolved) continue;
        expect(["read_file", "write_file", "run_command"], `seed ${seed}: ${event.requested} resolved to ${event.resolved}`).toContain(event.resolved);
      }
      expect(events.at(-1)?.type, `seed ${seed}: the run did not end with its stop`).toBe("runtime_stop");
      // Shortening happens at most twice a run, and each step is announced.
      const shrinks = events.filter((event) => event.type === "context_shrunk");
      expect(shrinks.length, `seed ${seed}`).toBeLessThanOrEqual(2);
    }
  });

  it("exercises what it claims to: every status, translated and unknown names, executed tools", async () => {
    const statuses = new Set<string>();
    let aliased = 0, unknown = 0, ran = 0, threw = 0, shrunk = 0;
    for (const seed of SEEDS) {
      const { result, events, executed } = await runSeed(seed, true);
      if (result) statuses.add(result.status); else threw += 1;
      ran += executed.length;
      for (const event of events) if (event.type === "tool_name") event.resolved ? aliased += 1 : unknown += 1;
      shrunk += events.filter((event) => event.type === "context_shrunk").length;
    }
    if (process.env.SEED) return;
    // A random suite that only ever takes one path proves nothing: these floors keep it honest.
    expect([...statuses]).toEqual(expect.arrayContaining(["completed", "failed", "iteration_limit"]));
    expect(aliased).toBeGreaterThan(20);
    expect(unknown).toBeGreaterThan(20);
    expect(ran).toBeGreaterThan(50);
    expect(threw).toBeGreaterThan(0);
    expect(shrunk).toBeGreaterThan(10);
  });

  it("never runs a tool that needs approval when approval is refused", async () => {
    for (const seed of SEEDS.slice(0, 150)) {
      const { result, executed } = await runSeed(seed, false);
      expect(executed.filter((run) => run.name !== "read_file"), `seed ${seed}`).toEqual([]);
      if (result && executed.length === 0 && result.status === "needs_approval") expect(result.summary).toMatch(/approval/);
    }
  });

  it("is deterministic: the same seed makes the same run", async () => {
    for (const seed of [3, 17, 99]) {
      const a = await runSeed(seed, true);
      const b = await runSeed(seed, true);
      expect(b.result?.status).toBe(a.result?.status);
      expect(b.executed).toEqual(a.executed);
      expect(b.requests.length).toBe(a.requests.length);
    }
  });
});
