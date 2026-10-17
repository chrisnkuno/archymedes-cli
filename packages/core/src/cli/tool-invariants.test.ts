import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, lstatSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoundedAgentRuntime, type AgentMessage, type AgentModelTurn, type AgentTool, type AgentToolCall } from "../agent-runtime";
import { LocalWorkspace } from "./backends";
import { createArchymedesTools, TodoList } from "./tools";
import { normalizeToolArguments, type ToolInputSchema } from "./tool-schema";

/**
 * Tool-call invariants on the real tool set, in a real directory.
 *
 * `runtime-invariants.test.ts` holds the runtime to its transcript contract with stand-in tools.
 * This suite puts the shipped tools behind it: a seeded random model calls real, aliased and
 * invented names with random arguments — missing, extra, wrongly typed, synonyms, paths that climb
 * out of the project, absolute paths, a symlink that points outside — and after every call the disk
 * is compared with what that call was allowed to do. Whatever the model sends:
 *
 * - nothing outside the project changes, and nothing new appears beside it;
 * - a tool that declares no effect changes nothing at all;
 * - arguments the validator refuses never change anything;
 * - a failed edit leaves the file exactly as it was (no half-applied edits);
 * - a write that succeeded put exactly that content at a path inside the project;
 * - every call is answered once, results stay within the configured bound, the run ends.
 *
 * A failure names its seed: `SEED=<n> npx vitest run tool-invariants`.
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

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

/** Ours, ones `tool-aliases` translates, ones outside the run's capabilities, and nonsense. */
const NAMES = [
  "read_file", "write_file", "edit_file", "list_files", "glob_files", "grep_files", "todo_write", "todo_read", "compute",
  "notebook_edit", "remember", "find_symbol", "repo_map", "view_image",
  "Read", "Write", "Edit", "MultiEdit", "str_replace_based_edit_tool", "functions.read_file", "LS", "Glob", "Grep",
  "run_command", "Bash", "deploy_app", "bogus_tool",
];

let base: string, root: string, outside: string, config: string;
const savedConfig = process.env.ARCHYMEDES_CONFIG_DIR;

const PATHS = () => [
  "src/a.ts", "README.md", "notes.ipynb", "new/deep/file.ts", "src", ".", "", "   ",
  "../outside/secret.txt", "../outside/planted.txt", "src/../../outside/secret.txt", "link/secret.txt", "link/planted.txt", "link/new/deep/planted.txt", "link",
  path.join(outside, "secret.txt"), path.join(outside, "planted.txt"), "/etc/hostname", "~/planted.txt", "src/a.ts\u0000x", "C:\\Windows\\x",
];

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)];
}

function randomValue(next: () => number, key: string): unknown {
  const r = next();
  if (r < 0.08) return null;
  if (r < 0.14) return 42;
  if (r < 0.18) return ["a", "b"];
  if (r < 0.2) return { nested: true };
  switch (key) {
    case "path": case "file_path": case "filePath": case "directory": return pick(next, PATHS());
    case "content": case "text": case "source": case "newText": case "new_string": return pick(next, ["export const a = 3;\n", "", "x".repeat(5_000), "line\r\nwindows\r\n", "ünïcödé ✓\n"]);
    case "oldText": case "old_string": return pick(next, ["export const a = 1;", "export const", "not there", "", "\n"]);
    case "edits": return pick(next, [
      JSON.stringify([{ oldText: "export const b = 2;", newText: "export const b = 20;" }]),
      JSON.stringify([{ oldText: "export const b = 2;", newText: "x" }, { oldText: "missing", newText: "y" }]),
      [{ oldText: "export const a = 1;", newText: "export const a = 10;" }], "[not json", "[]",
    ]);
    case "pattern": return pick(next, ["**/*", "src/*.ts", "../**", "/**", "**/*.{ts,md}", "["]);
    case "query": case "name": return pick(next, ["export", "(", "a", ".*", "", "secret"]);
    case "regex": case "replaceAll": case "staged": return pick(next, [true, false, "true", "yes"]);
    case "depth": case "offset": case "limit": case "maxChars": case "n": case "cell_index": return pick(next, [0, 1, 3, -1, 1.5, "2", 1e9, Number.NaN]);
    case "items": return pick(next, [["read", "fix"], "one", [], [1, 2]]);
    case "complete": case "start": return pick(next, [[1], 1, "1", [99]]);
    case "expr": return pick(next, ["1+1", "2^64", "log(0)", "((", "sqrt(-1)"]);
    case "scope": return pick(next, ["project", "user", "global"]);
    case "operation": return pick(next, ["replace", "insert", "delete", "explode"]);
    default: return pick(next, ["x", 1, true]);
  }
}

const KEYS = ["path", "file_path", "content", "text", "oldText", "newText", "old_string", "new_string", "replaceAll", "edits", "pattern", "query", "regex", "include", "depth", "offset", "limit", "items", "complete", "start", "expr", "scope", "operation", "cell_index", "source", "name", "maxChars", "bogus"];

function randomArguments(next: () => number): unknown {
  const r = next();
  if (r < 0.05) return "not an object";
  if (r < 0.08) return null;
  if (r < 0.1) return JSON.stringify({ path: "src/a.ts" });
  const args: Record<string, unknown> = {};
  for (let n = Math.floor(next() * 5); n > 0; n -= 1) {
    const key = pick(next, KEYS);
    args[key] = randomValue(next, key);
  }
  return args;
}

/** Arguments that fit the tool's schema — so the call reaches the tool body — with values that still probe it. */
function shapedArguments(next: () => number, schema: ToolInputSchema): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (!schema.required?.includes(key) && next() > 0.35) continue;
    const type = (property as { type?: string; enum?: string[]; items?: { type?: string } }).type;
    const options = (property as { enum?: string[] }).enum;
    if (options) { args[key] = pick(next, options); continue; }
    switch (type) {
      case "integer": args[key] = pick(next, [1, 2, 3, 20]); break;
      case "boolean": args[key] = next() < 0.5; break;
      case "array": args[key] = (property as { items?: { type?: string } }).items?.type === "integer" ? [1] : ["read the code", "fix it"]; break;
      default: {
        const value = randomValue(next, key);
        args[key] = typeof value === "string" ? value : pick(next, ["src/a.ts", "export const a = 1;", "x"]);
      }
    }
  }
  return args;
}

function randomTurn(next: () => number, index: number, schemas: ReadonlyMap<string, ToolInputSchema>): AgentModelTurn {
  const base = { responseId: `r${index}`, model: "random", usage, content: "", toolCalls: [] as AgentToolCall[] };
  if (next() < 0.12) return { ...base, finishReason: "stop", content: "Done." };
  const toolCalls = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, i) => {
    // Mostly our own names, so most calls reach a tool; the rest exercise translation and refusal.
    const name = next() < 0.7 ? pick(next, NAMES.slice(0, 14)) : pick(next, NAMES);
    const schema = schemas.get(name);
    // Now and then the call a working model makes, so success is exercised as well as refusal.
    const typical: Record<string, () => Record<string, unknown>> = {
      edit_file: () => ({ path: "src/a.ts", oldText: pick(next, ["export const b = 2;", "export const a = 1;"]), newText: pick(next, ["export const b = 3;", ""]) }),
      read_file: () => ({ path: pick(next, ["src/a.ts", "README.md", "link/secret.txt"]) }),
    };
    const args = typical[name] && next() < 0.4 ? typical[name]() : schema && next() < 0.6 ? shapedArguments(next, schema) : randomArguments(next);
    return { id: `c${index}_${i}`, name, arguments: args };
  });
  return { ...base, finishReason: "tool_calls", toolCalls };
}

/** Every file and link under `dir`, with what it holds: the thing compared before and after. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const rel = path.relative(dir, full);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) out.set(rel, `link:${readlinkSync(full)}`);
      else if (stat.isDirectory()) { out.set(rel, "dir"); walk(full); }
      else out.set(rel, createHash("sha1").update(readFileSync(full)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

const same = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
const changes = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key));

function project(): void {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(path.join(root, "README.md"), "# Project\n");
  writeFileSync(path.join(root, "notes.ipynb"), JSON.stringify({ cells: [{ cell_type: "code", source: ["print(1)"], metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  writeFileSync(path.join(outside, "secret.txt"), "do not touch\n");
  symlinkSync(outside, path.join(root, "link"));
}

type Violation = string;

/** What the calls actually did, so the floors below can say the suite reached the cases it is about. */
const reached = { written: 0, editFailed: 0, edited: 0, refused: 0, escapes: 0, read: 0 };
const ESCAPING = /^(\.\.|\/|~|link)|\/\.\.\//;

async function runSeed(seed: number) {
  project();
  const next = random(seed);
  const violations: Violation[] = [];
  const outsideBefore = snapshot(outside);
  const baseBefore = readdirSync(base).sort();
  const real = await createArchymedesTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), memoryRoot: root, fetchImpl: (async () => new Response("page")) as typeof fetch });
  const schemas = new Map(real.map((tool) => [tool.name, tool.inputSchema as ToolInputSchema]));
  let executed = 0;
  // Each real tool, watched: the disk before and after every call, judged against what it may do.
  const watched: AgentTool[] = real.map((tool) => ({
    ...tool,
    async execute(args, context) {
      executed += 1;
      const before = snapshot(root);
      let refused = false;
      try { normalizeToolArguments(tool.name, tool.inputSchema as ToolInputSchema, args); } catch { refused = true; }
      if (refused) reached.refused += 1;
      const target = (args as { path?: unknown }).path;
      if (typeof target === "string" && ESCAPING.test(target)) reached.escapes += 1;
      const editTarget = tool.name === "edit_file" && typeof (args as { path?: unknown }).path === "string" ? path.resolve(root, (args as { path: string }).path) : undefined;
      let result;
      try {
        result = await tool.execute(args, context);
      } finally {
        const after = snapshot(root);
        const where = `seed ${seed}: ${tool.name}(${JSON.stringify(args).slice(0, 160)})`;
        if (tool.effect === "none" && !same(before, after)) violations.push(`${where} declares no effect but changed ${changes(before, after).join(", ")}`);
        if (refused && !same(before, after)) violations.push(`${where} was refused by the validator but changed ${changes(before, after).join(", ")}`);
        if (editTarget && (result === undefined || result.isError) && !same(before, after)) violations.push(`${where} failed but changed ${changes(before, after).join(", ")}`);
        if (editTarget && !refused) result && !result.isError ? reached.edited += 1 : reached.editFailed += 1;
        if (tool.name === "read_file" && result && !result.isError) reached.read += 1;
        if (tool.name === "write_file" && result && !result.isError) {
          const written = (args as { path?: unknown; content?: unknown });
          if (typeof written.path === "string" && typeof written.content === "string") {
            const target = path.resolve(root, written.path);
            if (path.relative(root, target).startsWith("..")) violations.push(`${where} reported success for a path outside the project`);
            else if (readFileSync(target, "utf8") !== written.content) violations.push(`${where} reported success but the file holds something else`);
            else reached.written += 1;
          }
        }
      }
      // Reading is not changing, but a file outside the project must not come back through a link either.
      if (result && result.content.includes("do not touch")) violations.push(`seed ${seed}: ${tool.name}(${JSON.stringify(args).slice(0, 120)}) returned the contents of a file outside the project`);
      return result;
    },
  }));
  const runtime = new BoundedAgentRuntime({
    tools: watched,
    prices: { inputRatePerMillion: 1, outputRatePerMillion: 1 },
    retry: { sleep: async () => true, random: () => 0 },
    model: { async complete(request) { return randomTurn(next, request.messages.length, schemas); } },
    control: {
      async heartbeat() {},
      async isCancellationRequested() { return false; },
      async isToolCallApproved() { return true; },
      async persistEvent() {},
    },
  });
  const result = await runtime.execute({
    taskId: "t", runId: "r", stepId: "s", objective: "do the thing", systemPrompt: "system",
    allowedCapabilityIds: ["workspace.files.read", "workspace.files", "reasoning.plan"],
    maxIterations: 6, maxToolCalls: 14, maxToolCallsPerTurn: 4,
    maxToolResultChars: 2_000, maxTotalToolResultChars: 20_000, maxOutputTokens: 500, modelReservationRwf: 1_000_000, safetyIdentifier: "seed",
  });
  if (!same(outsideBefore, snapshot(outside))) violations.push(`seed ${seed}: outside the project changed: ${changes(outsideBefore, snapshot(outside)).join(", ")}`);
  const baseAfter = readdirSync(base).sort();
  if (baseAfter.join() !== baseBefore.join()) violations.push(`seed ${seed}: beside the project appeared ${baseAfter.filter((name) => !baseBefore.includes(name)).join(", ")}`);
  return { result, violations, executed };
}

function assertAnsweredOnce(messages: readonly AgentMessage[], where: string) {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== "assistant" || !("toolCalls" in message)) continue;
    const pending = new Map(message.toolCalls.map((call) => [call.id, call.name]));
    let j = i + 1;
    for (; j < messages.length && messages[j].role === "tool"; j += 1) {
      const answer = messages[j] as Extract<AgentMessage, { role: "tool" }>;
      expect(pending.get(answer.toolCallId), `${where}: message ${j}`).toBe(answer.name);
      pending.delete(answer.toolCallId);
      // The bound, with room for the note that says a result was cut.
      expect(answer.content.length, `${where}: ${answer.name} result of ${answer.content.length} chars`).toBeLessThanOrEqual(2_000 + 600);
    }
    expect([...pending.keys()], `${where}: unanswered after message ${i}`).toEqual([]);
  }
}

const SEEDS = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: 150 }, (_, i) => i + 1);

describe("the real tools under a random model", () => {
  beforeAll(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "tool-invariants-"));
    root = path.join(base, "project");
    outside = path.join(base, "outside");
    config = path.join(base, "config");
    mkdirSync(config);
    process.env.ARCHYMEDES_CONFIG_DIR = config; // user-scope memory lands here, never in the real one
  });
  afterAll(() => {
    if (savedConfig === undefined) delete process.env.ARCHYMEDES_CONFIG_DIR;
    else process.env.ARCHYMEDES_CONFIG_DIR = savedConfig;
    rmSync(base, { recursive: true, force: true });
  });

  it("keeps every call inside its effect and inside the project, whatever is sent", async () => {
    let executed = 0;
    const statuses = new Set<string>();
    for (const seed of SEEDS) {
      const run = await runSeed(seed);
      expect(run.violations).toEqual([]);
      assertAnsweredOnce(run.result.messages, `seed ${seed}`);
      expect(run.result.toolCallsExecuted, `seed ${seed}`).toBeLessThanOrEqual(14);
      statuses.add(run.result.status);
      executed += run.executed;
    }
    if (process.env.SEED) return;
    // Floors, so a generator that stopped reaching the tools cannot pass quietly.
    if (process.env.REACHED) writeFileSync(process.env.REACHED, JSON.stringify(reached));
    expect(executed).toBeGreaterThan(400);
    expect(reached.written, "successful writes").toBeGreaterThan(5);
    expect(reached.edited, "successful edits").toBeGreaterThan(3);
    expect(reached.editFailed, "failed edits").toBeGreaterThan(10);
    expect(reached.refused, "calls the validator refused").toBeGreaterThan(50);
    expect(reached.escapes, "paths reaching outside the project").toBeGreaterThan(30);
    expect(reached.read, "successful reads").toBeGreaterThan(10);
    expect([...statuses]).toEqual(expect.arrayContaining(["completed", "iteration_limit"]));
  }, 240_000);
});
