/**
 * Token saver: how a session spends less per request when its requests are rationed.
 *
 * Free mode runs on a daily allowance — 100,000 tokens and 25 requests through the hosted gateway —
 * and every request resends everything: the system prompt (rules, mode guidance, environment,
 * project layout, the whole AGENTS.md), the schema of every tool, and the transcript with every
 * file the agent has read so far. Measured before this file existed, the fixed part alone was
 * 7,000–10,000 tokens, paid again on every tool iteration; a session reading three files could
 * spend a fifth of a day's allowance on one question.
 *
 * Nothing here changes what the agent may do. It changes how much is resent:
 *
 * - **Budgets** sized for a 16K working window with small tool results, so compaction and in-turn
 *   stubbing start well before a 32K window would force them (`tokenSaverBudgets`).
 * - **A smaller tool set**: tools that are rarely needed and expensive to describe (web research,
 *   deploy, notebooks, images, delegation, which also multiplies requests) are offered only when the
 *   request or the mode calls for them (`leanToolset`).
 * - **Earlier turns' tool output as stubs** in what is sent, never in what is saved: the full
 *   results stay in the session file, and the model is told how to get any of them back
 *   (`stubEarlierToolResults`, `restoreFullHistory`).
 *
 * The lean system prompt itself lives with the full one in `prompt.ts`, so the two cannot drift
 * apart on the rules that matter for safety.
 *
 * On by default for a provider that declares it (`AgentTurnProvider.tokenSaver`);
 * `ARCHYMEDES_TOKEN_SAVER=off` turns it off.
 */
import type { AgentMessage, AgentTool } from "../agent-runtime";
import type { ModelCapabilities } from "../providers/model-capabilities";
import type { ArchymedesBudgets } from "./agent";
import type { ArchymedesMode } from "./permissions";

/** The window a token-saving session budgets against, whatever larger window its model has. */
export const TOKEN_SAVER_CONTEXT_LIMIT = 16_384;
/** Largest single tool result sent whole; the rest is saved as an artifact the agent can page through. */
export const TOKEN_SAVER_TOOL_RESULT_CHARS = 3_000;
/** Tool output a single turn may accumulate before its older results are stubbed. */
export const TOKEN_SAVER_TOTAL_TOOL_RESULT_CHARS = 24_000;
/** Project instructions (AGENTS.md and friends) included in a lean prompt. */
export const TOKEN_SAVER_INSTRUCTION_CHARS = 4_000;
/** Earlier-turn tool results at or under this size are cheaper to keep than to stub. */
const STUB_MIN_CHARS = 400;
/** Earlier-turn tool-call string arguments (a whole file passed to write_file) past this are elided. */
const ARGUMENT_STUB_MIN_CHARS = 1_500;
const PREVIEW_CHARS = 120;

/** On unless `ARCHYMEDES_TOKEN_SAVER` says off (`off`, `0`, `false`, `no`, `disabled`). */
export function tokenSaverEnabled(environment: Record<string, string | undefined>): boolean {
  const value = environment.ARCHYMEDES_TOKEN_SAVER?.trim().toLowerCase();
  return !value || !["off", "0", "false", "no", "disabled"].includes(value);
}

/**
 * The budgets a token-saving session runs under, from what its model can do.
 *
 * Every figure is the smaller of the saver's and the model's own, so a model with an 8K window is
 * still budgeted as one. 16K rather than the model's 32K moves compaction from about 20K tokens of
 * transcript to about 8.5K — compaction costs one summary request, but every request after it is
 * half the size. Eight calls per turn rather than sixteen keeps one iteration's results inside the
 * per-turn tool-output allowance.
 */
export function tokenSaverBudgets(capabilities: ModelCapabilities): Pick<ArchymedesBudgets, "contextLimit" | "maxOutputTokens" | "maxToolResultChars" | "maxTotalToolResultChars" | "maxToolCallsPerTurn"> {
  return {
    contextLimit: Math.min(capabilities.contextWindow, TOKEN_SAVER_CONTEXT_LIMIT),
    maxOutputTokens: Math.max(256, Math.min(capabilities.maxOutputTokens, 4_096)),
    maxToolResultChars: Math.min(TOKEN_SAVER_TOOL_RESULT_CHARS, Math.round(capabilities.contextWindow * 0.2)),
    maxTotalToolResultChars: Math.min(TOKEN_SAVER_TOTAL_TOOL_RESULT_CHARS, capabilities.contextWindow * 2),
    maxToolCallsPerTurn: 8,
  };
}

/**
 * Tools a lean session leaves out unless the request or mode asks for them, each with the pattern
 * that brings it back. A tool's schema is resent on every request whether or not it is called, and
 * these are the long-described, rarely-called ones.
 */
const ON_REQUEST: ReadonlyArray<{ tools: readonly string[]; when: RegExp }> = [
  { tools: ["web_search", "web_fetch"], when: /\b(?:web|internet|online|google|look\s*up|search\s+for|latest|news|docs?|documentation|url|website|release notes|changelog|advisory|cve)\b|https?:\/\//i },
  { tools: ["deep_research"], when: /\bresearch\b/i },
  { tools: ["deploy_app"], when: /\b(?:deploy|publish|vercel|render\.com|hosting|go live)\b/i },
  { tools: ["notebook_edit"], when: /\.ipynb\b|\bnotebook\b|\bjupyter\b/i },
  { tools: ["view_image"], when: /\.(?:png|jpe?g|gif|webp|bmp|svg)\b|\b(?:image|screenshot|picture|photo|diagram)\b/i },
  { tools: ["git_log", "git_show"], when: /\b(?:git|commit|history|log|blame|branch|changed since|last change)\b/i },
  { tools: ["scan_secrets"], when: /\b(?:secret|credential|leak|api key|token|password)s?\b/i },
  { tools: ["repo_map", "find_symbol"], when: /\b(?:symbol|definition|references?|callers?|architecture|overview|structure|map|where is)\b/i },
  { tools: ["remember"], when: /\b(?:remember|memori[sz]e|forget|note that)\b/i },
  { tools: ["delegate_task", "delegate_readonly_task"], when: /\b(?:delegate|sub-?agents?|in parallel)\b/i },
  { tools: ["application_status"], when: /\b(?:app|application|server|preview|port)\b.*\b(?:running|status|up|reachable)\b/i },
  // Pure bookkeeping: `todo_write` already returns the list it wrote.
  { tools: ["todo_read"], when: /(?!)/ },
];

/** What defender mode is for; never trimmed there. */
const DEFENDER_TOOLS = new Set(["query_defensive_brain", "read_playbook", "scan_secrets", "web_search", "web_fetch"]);
const DEFENDER_ONLY = new Set(["query_defensive_brain", "read_playbook"]);

/**
 * The tools a lean session offers for this request.
 *
 * Built-in tools only: an MCP server or plugin tool was configured by the user on purpose and is
 * always kept. Applied after the intent profile (`tool-profile.ts`), so a chat-only request still
 * sends no tools at all.
 */
export function leanToolset(tools: readonly AgentTool[], mode: ArchymedesMode, objective: string): AgentTool[] {
  const wanted = new Set<string>();
  const optional = new Set<string>();
  for (const rule of ON_REQUEST) {
    for (const name of rule.tools) {
      optional.add(name);
      if (rule.when.test(objective)) wanted.add(name);
    }
  }
  for (const name of DEFENDER_ONLY) optional.add(name);
  return tools.filter((tool) => {
    if (tool.provenance && tool.provenance.kind !== "built-in") return true;
    if (mode === "defender" && DEFENDER_TOOLS.has(tool.name)) return true;
    return !optional.has(tool.name) || wanted.has(tool.name);
  });
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

function stubArguments(value: unknown): unknown {
  if (typeof value === "string") return value.length > ARGUMENT_STUB_MIN_CHARS ? `[${value.length} chars omitted from an earlier turn]` : value;
  if (Array.isArray(value)) return value.map(stubArguments);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stubArguments(entry)]));
  return value;
}

/** The stub an earlier turn's tool result is sent as. */
export function earlierToolResultStub(toolName: string, content: string): string {
  return `[earlier ${toolName} result, ${content.length} chars, omitted to save tokens; run the tool again if you need it. Began: "${preview(content)}"]`;
}

/**
 * History as a lean session sends it: earlier turns' tool output replaced by short stubs.
 *
 * Applied to prior turns only — the runtime adds the current turn after this history, so nothing
 * the agent is working with right now is touched. The structure is kept exactly: every message is
 * still there, every tool call still has its result with the same id and name, so no provider sees
 * an orphaned call. Short results (an exit code, "file written") and errors are kept whole, since
 * a stub would cost about as much and the error is often why the next turn exists. Large string
 * arguments of earlier calls (a whole file given to `write_file`) are elided the same way.
 *
 * Always a new array; messages that needed no change are the same objects as before.
 */
export function stubEarlierToolResults(history: readonly AgentMessage[]): AgentMessage[] {
  return history.map((message): AgentMessage => {
    if (message.role === "tool") {
      const looksLikeError = /^\s*(?:error|failed|exit code [1-9])/i.test(message.content);
      if (message.content.length <= STUB_MIN_CHARS || looksLikeError) return message;
      const { images: _images, ...rest } = message;
      return { ...rest, content: earlierToolResultStub(message.name, message.content) };
    }
    if (message.role === "assistant" && "toolCalls" in message) {
      const calls = message.toolCalls.map((call) => {
        const serialized = JSON.stringify(call.arguments ?? {});
        if (serialized.length <= ARGUMENT_STUB_MIN_CHARS) return call;
        const argumentsStub = stubArguments(call.arguments);
        if (JSON.stringify(argumentsStub) === serialized) return call;
        return { ...call, arguments: argumentsStub };
      });
      return calls.every((call, index) => call === message.toolCalls[index]) ? message : { ...message, toolCalls: calls };
    }
    return message;
  });
}

/**
 * The runtime's transcript with the full prior history put back in place of the stubs it was sent.
 *
 * The runtime returns `[system, ...history, ...this turn]`; only the history part was stubbed, so
 * it is swapped for the original and the rest is kept as the runtime produced it. Anything not of
 * that shape is returned unchanged rather than guessed at.
 */
export function restoreFullHistory(messages: readonly AgentMessage[], original: readonly AgentMessage[], sent: readonly AgentMessage[]): AgentMessage[] {
  if (original.length !== sent.length) return [...messages];
  if (messages[0]?.role !== "system" || messages.length < 1 + sent.length) return [...messages];
  return [messages[0], ...original, ...messages.slice(1 + sent.length)];
}
