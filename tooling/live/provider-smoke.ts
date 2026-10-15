/**
 * Live provider smoke test: one real tool round trip against every provider you have a key for.
 *
 *   bun run test:live                      every configured provider, its default (or *_MODEL) model
 *   bun run test:live groq mistral         only these providers
 *   bun run test:live groq:qwen/qwen3-32b  a specific model
 *   bun run test:live --census [targets]   which tool names each model reaches for (see below)
 *
 * `chat-dialects.test.ts` proves each request matches what the vendor *documents*. This proves the
 * vendor actually accepts it, which documentation does not always say: an unknown field, a tool
 * message shape or an id format a vendor rejects only shows up against the real endpoint.
 *
 * Each provider gets two turns: one that must call a tool, and one that answers with the tool's
 * result, so the tool-call and tool-result message shapes are both exercised. It spends real tokens
 * (a few hundred per provider), so it is opt-in and never part of `bun run check`.
 *
 * `--census` offers each model Archymedes' real tool set and five ordinary coding requests, runs
 * nothing, and lists every tool name it called: ours, translated by `tool-aliases`, or unknown. An
 * unknown name is one to add to that table before a user's run stops on it.
 *
 * Keys come from the same place the app reads them: saved settings, overridden by the environment.
 */
import type { AgentMessage, AgentModelRequest } from "../../packages/core/src/agent-runtime";
import { availableProviders, PROVIDERS, providerEnvPrefix } from "../../packages/core/src/providers/agent-matrix";
import { isProviderId, type ProviderId } from "../../packages/core/src/providers/provider-specs";
import { createArchymedesTools, TodoList } from "../../packages/core/src/cli/tools";
import { resolveToolCall } from "../../packages/core/src/tool-aliases";
import { loadSettings, mergedEnvironment } from "../../packages/archymedes-cli/src/platform/settings";

/** Need a gateway or local daemon rather than a key, so they run only when named. */
const ONLY_WHEN_NAMED: readonly ProviderId[] = ["ollama", "free", "archymedes-cloud"];

const tools: AgentModelRequest["tools"] = [{
  name: "echo",
  description: "Returns the given text unchanged.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
}];

type Target = { id: ProviderId; model: string };
type Outcome = { target: Target; ok: boolean; ms: number; detail: string };

function targets(environment: Record<string, string | undefined>, args: string[]): Target[] | string {
  const modelFor = (id: ProviderId) => environment[`${providerEnvPrefix(id)}_MODEL`]?.trim() || PROVIDERS[id].defaultModel;
  if (args.length === 0) {
    return availableProviders(environment).filter((spec) => !ONLY_WHEN_NAMED.includes(spec.id)).map((spec) => ({ id: spec.id, model: modelFor(spec.id) }));
  }
  const chosen: Target[] = [];
  for (const arg of args) {
    const [id, ...rest] = arg.split(":");
    if (!isProviderId(id)) return `Unknown provider "${id}".`;
    chosen.push({ id, model: rest.join(":") || modelFor(id) });
  }
  return chosen;
}

async function smoke(target: Target, environment: Record<string, string | undefined>): Promise<Outcome> {
  const started = Date.now();
  const done = (ok: boolean, detail: string): Outcome => ({ target, ok, ms: Date.now() - started, detail });
  try {
    const provider = PROVIDERS[target.id].create(environment, target.model);
    const base = { tools, maxOutputTokens: 512, safetyIdentifier: "archymedes_live_smoke", signal: AbortSignal.timeout(60_000) };
    const messages: AgentMessage[] = [
      { role: "system", content: "You are a test harness. Follow the instruction exactly." },
      { role: "user", content: 'Call the echo tool with text "pong". Do not answer in prose.' },
    ];
    const first = await provider.complete({ ...base, messages });
    const call = first.toolCalls[0];
    if (!call) return done(false, `no tool call (finish ${first.finishReason}): ${first.content.slice(0, 80) || "empty reply"}`);
    if (call.name !== "echo") return done(false, `called an unknown tool "${call.name}"`);

    messages.push(
      { role: "assistant", content: first.content, toolCalls: first.toolCalls },
      ...first.toolCalls.map((each): AgentMessage => ({ role: "tool", toolCallId: each.id, name: each.name, content: String((each.arguments as { text?: unknown }).text ?? "") })),
    );
    const second = await provider.complete({ ...base, messages });
    if (second.finishReason === "refusal") return done(false, `refused after the tool result: ${second.refusal ?? ""}`);
    const tokens = first.usage.totalTokens + second.usage.totalTokens;
    return done(true, `${tokens} tokens; replied "${second.content.replace(/\s+/g, " ").slice(0, 40)}"`);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const message = error instanceof Error ? error.message : String(error);
    return done(false, `${typeof status === "number" ? `HTTP ${status}: ` : ""}${message.split("\n")[0].slice(0, 200)}`);
  }
}

const CENSUS_REQUESTS = [
  "Run the project's test suite and tell me whether it passes.",
  "Find where the function parseConfig is defined.",
  "In README.md, fix the typo 'teh' so it reads 'the'.",
  "Show me what files are in the src directory.",
  "Create a file notes/todo.md listing three next steps for this project.",
];

/** One census row per tool name a model called: how often, and what Archymedes makes of it. */
async function census(target: Target, environment: Record<string, string | undefined>): Promise<string[]> {
  // Definitions only: nothing is executed, so the workspace is never touched.
  const tools = await createArchymedesTools({ workspace: { commandGuidance: "" } as never, todos: new TodoList() });
  const definitions = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const available = new Set(tools.map((tool) => tool.name));
  const provider = PROVIDERS[target.id].create(environment, target.model);
  const seen = new Map<string, { count: number; verdict: string }>();
  const errors: string[] = [];
  // One request at a time per provider: free tiers rate-limit a burst of five (Groq does).
  for (const content of CENSUS_REQUESTS) {
    try {
      const turn = await provider.complete({
        tools: definitions, maxOutputTokens: 1_024, safetyIdentifier: "archymedes_live_census", signal: AbortSignal.timeout(90_000),
        messages: [{ role: "system", content: "You are a coding agent working in the user's project. Use the tools to act." }, { role: "user", content }],
      });
      for (const call of turn.toolCalls) {
        const resolution = resolveToolCall(call, available);
        const verdict = resolution.kind === "exact" ? "ours" : resolution.kind === "alias" ? `-> ${resolution.call.name}` : "UNKNOWN";
        const entry = seen.get(call.name) ?? { count: 0, verdict };
        seen.set(call.name, { count: entry.count + 1, verdict });
      }
    } catch (error) {
      errors.push((error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120));
    }
  }
  const rows = [...seen].sort((a, b) => b[1].count - a[1].count).map(([name, { count, verdict }]) => `  ${name.padEnd(36)} x${count}  ${verdict}`);
  return [`${target.id}:${target.model}`, ...(rows.length ? rows : ["  (no tool calls)"]), ...errors.map((error) => `  error: ${error}`)];
}

const environment = mergedEnvironment(await loadSettings(), process.env);
const argv = process.argv.slice(2);
const censusMode = argv.includes("--census");
const chosen = targets(environment, argv.filter((arg) => arg !== "--census"));
if (typeof chosen === "string") {
  console.error(chosen);
  process.exit(2);
}
if (chosen.length === 0) {
  console.error("No provider is configured. Add a key in archymedes settings, or name a provider to try.");
  process.exit(2);
}

if (censusMode) {
  const reports = await Promise.all(chosen.map((target) => census(target, environment)));
  console.log(reports.map((lines) => lines.join("\n")).join("\n\n"));
  const unknown = reports.flat().filter((line) => line.endsWith("UNKNOWN")).length;
  console.log(`\n${unknown} unknown tool name${unknown === 1 ? "" : "s"}${unknown ? ": add them to packages/core/src/tool-aliases.ts" : ""}`);
  process.exit(unknown ? 1 : 0);
}

// In parallel: these are different vendors, and one slow endpoint should not stretch the run.
const outcomes = await Promise.all(chosen.map((target) => smoke(target, environment)));
for (const { target, ok, ms, detail } of outcomes) {
  console.log(`${ok ? "pass" : "FAIL"}  ${`${target.id}:${target.model}`.padEnd(48)} ${String(ms).padStart(6)} ms  ${detail}`);
}
const failed = outcomes.filter((outcome) => !outcome.ok).length;
console.log(`\n${outcomes.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
