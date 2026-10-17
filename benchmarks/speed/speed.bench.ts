/**
 * How fast Archymedes itself is — everything except the model, which is measured from real sessions
 * with `analyze-session.ts` (97–99% of a long task's wall time is the model; this file is the rest).
 *
 *   bun run bench:speed            print the table and write benchmarks/speed/latest.json
 *   bun run bench:speed -- --check exit 1 when a budget in benchmarks/speed/budgets.json is broken
 *
 * Every scenario uses a stub model that answers instantly, so what is measured is the agent's own
 * work: starting up, running a tool, and the fixed cost around each iteration and each turn.
 * Medians, not means: one slow sample on a loaded machine should not move a number.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../../packages/core/src/agent-runtime";
import { ArchymedesAgent } from "../../packages/core/src/cli/agent";
import { LocalWorkspace } from "../../packages/core/src/cli/backends";
import { NestedInstructionTracker } from "../../packages/core/src/cli/nested-instructions";
import { createArchymedesTools, TodoList } from "../../packages/core/src/cli/tools";
import { RequestPacer } from "../../packages/core/src/providers/request-pacer";

const repo = path.resolve(import.meta.dir, "../..");
const entry = path.join(repo, "packages/friday-cli/src/friday.ts");

type Result = { id: string; what: string; unit: string; value: number };
const results: Result[] = [];
const record = (id: string, what: string, unit: string, value: number) => results.push({ id, what, unit, value: Math.round(value * 100) / 100 });

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function time(fn: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}
async function sample(count: number, fn: () => Promise<unknown>): Promise<number> {
  await fn(); // warm: module loading and caches are not what a user pays per call
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) values.push(await time(fn));
  return median(values);
}

// --- startup (a fresh process each time, because that is what a user pays) ---

async function runOnce(args: string[], input?: string, until?: (out: string) => boolean): Promise<number> {
  const started = performance.now();
  const child = spawn("bun", ["run", entry, ...args], { cwd: repo, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  await new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (until?.(out)) { child.kill(); resolve(); }
    });
    child.on("close", () => resolve());
    if (input) child.stdin.write(input);
  });
  return performance.now() - started;
}

async function startup(): Promise<void> {
  const times = async (count: number, fn: () => Promise<number>) => { await fn(); const v: number[] = []; for (let i = 0; i < count; i += 1) v.push(await fn()); return median(v); };
  record("startup.version", "bun launches the agent and prints its version", "ms", await times(5, () => runOnce(["--version"])));
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n";
  record("startup.acp-initialize", "the agent answers the interface's first request (process start included)", "ms", await times(5, () => runOnce(["acp"], initialize, (out) => out.includes('"result"'))));
}

// --- tools, on this repository ---

async function tools(): Promise<void> {
  const workspace = new LocalWorkspace(repo);
  const set = await createArchymedesTools({ workspace, todos: new TodoList(), instructions: new NestedInstructionTracker(workspace) });
  const call = (name: string, args: Record<string, unknown>) => set.find((tool) => tool.name === name)!.execute(args, { signal: new AbortController().signal } as never);
  record("tool.read_file", "read a 20 KB file", "ms", await sample(15, () => call("read_file", { path: "README.md" })));
  record("tool.list_files", "list the project, two levels", "ms", await sample(9, () => call("list_files", { path: ".", depth: 2 })));
  record("tool.glob_files", "glob every TypeScript file", "ms", await sample(9, () => call("glob_files", { pattern: "**/*.ts" })));
  record("tool.grep_files", "search the whole project for a word", "ms", await sample(9, () => call("grep_files", { query: "compactionUrgency" })));
  record("tool.run_command", "run a command that exits at once", "ms", await sample(9, () => call("run_command", { command: "true" })));
}

// --- the agent's own cost, with a model that answers instantly ---

const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function stubModel(toolCallsBeforeAnswer: number): AgentTurnProvider {
  let served = 0;
  return {
    async complete(_request: AgentModelRequest): Promise<AgentModelTurn> {
      served += 1;
      const calling = served <= toolCallsBeforeAnswer;
      return {
        responseId: `r${served}`, model: "stub", usage, finishReason: calling ? "tool_calls" : "stop",
        content: calling ? "" : "Done.",
        toolCalls: calling ? [{ id: `c${served}`, name: "read_file", arguments: { path: "a.txt" } }] : [],
      } as AgentModelTurn;
    },
  };
}

async function agentCost(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "speed-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await fs.writeFile(path.join(root, "a.txt"), "hello\n");
    for (let i = 0; i < 200; i += 1) await fs.writeFile(path.join(root, `f${i}.ts`), `export const v${i} = ${i};\n`);
    const prices = { inputRatePerMillion: 2_000, outputRatePerMillion: 8_000 };
    const make = () => new ArchymedesAgent({ root, model: stubModel(0), prices, mode: "build", approve: async () => "allow" });
    const sendOn = (agent: ArchymedesAgent) => time(() => agent.send("go"));
    const withCalls = async (calls: number) => {
      const agent = new ArchymedesAgent({ root, model: stubModel(calls), prices, mode: "build", approve: async () => "allow" });
      await agent.send("warm the agent up"); // the first turn pays one-off costs; per-iteration is measured on a warm agent
      agent.warmUp();
      return time(() => agent.send("go"));
    };

    // The first turn of a session, cold: the environment probe runs before the first model call.
    const cold: number[] = [];
    for (let i = 0; i < 6; i += 1) cold.push(await sendOn(make()));
    record("turn.first-cold", "the first turn of a session, with nothing warmed up", "ms", median(cold));

    // The same turn when the interface warmed the agent up while the person was typing.
    const warmed: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const agent = make();
      agent.warmUp();
      await new Promise((resolve) => setTimeout(resolve, 600));
      warmed.push(await sendOn(agent));
    }
    record("turn.first-warmed", "the first turn after warmUp() had a moment to finish", "ms", median(warmed));

    // Every later turn of the same agent.
    const agent = make();
    await agent.send("first");
    const steady: number[] = [];
    for (let i = 0; i < 8; i += 1) steady.push(await sendOn(agent));
    record("turn.fixed", "any later one-reply turn: setup, checkpoint, journal, session save", "ms", median(steady));

    const plain = median(steady);
    const many: number[] = [];
    for (let i = 0; i < 5; i += 1) many.push(await withCalls(30));
    record("turn.per-iteration", "each further model call + tool call + persistence, 30 in a row", "ms", (median(many) - plain) / 30);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function pacing(): Promise<void> {
  const pacer = new RequestPacer({ windowCap: 1_000_000 });
  record("pacer.per-request", "the rate-limit window's cost per request while under the cap", "µs", (await time(async () => { for (let i = 0; i < 2000; i += 1) await pacer.wait(); })) / 2);
}

await startup();
await tools();
await agentCost();
await pacing();

// --- report ---

const budgetsFile = path.join(import.meta.dir, "budgets.json");
const budgets: Record<string, number> = JSON.parse(await fs.readFile(budgetsFile, "utf8").catch(() => "{}"));
const width = Math.max(...results.map((r) => r.id.length));
let broken = 0;
for (const r of results) {
  const budget = budgets[r.id];
  const over = budget !== undefined && r.value > budget;
  if (over) broken += 1;
  console.log(`${r.id.padEnd(width)}  ${String(r.value).padStart(9)} ${r.unit.padEnd(3)}  ${budget === undefined ? "".padEnd(14) : `budget ${String(budget).padStart(6)}`}  ${over ? "OVER" : ""}  ${r.what}`);
}
await fs.writeFile(path.join(import.meta.dir, "latest.json"), JSON.stringify({ at: new Date().toISOString(), machine: `${os.cpus()[0]?.model ?? "?"} x${os.cpus().length}`, bun: Bun.version, results }, null, 2) + "\n");
if (process.argv.includes("--check") && broken > 0) { console.error(`${broken} budget(s) broken`); process.exit(1); }
