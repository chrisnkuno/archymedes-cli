import { describe, expect, it } from "vitest";
import { validateHistory, type AgentMessage, type AgentTool } from "../agent-runtime";
import { capabilitiesFor } from "../providers/model-capabilities";
import {
  earlierToolResultStub, leanToolset, restoreFullHistory, stubEarlierToolResults, tokenSaverBudgets, tokenSaverEnabled,
  TOKEN_SAVER_CONTEXT_LIMIT, TOKEN_SAVER_TOOL_RESULT_CHARS, TOKEN_SAVER_TOTAL_TOOL_RESULT_CHARS,
} from "./token-saver";

const ALL_TOOLS = [
  "read_file", "list_files", "glob_files", "grep_files", "scan_secrets", "write_file", "edit_file", "run_command", "start_application",
  "application_status", "stop_application", "query_defensive_brain", "read_playbook", "todo_write", "todo_read", "compute", "web_search",
  "deep_research", "web_fetch", "deploy_app", "remember", "delegate_task", "delegate_readonly_task", "git_status", "git_diff", "git_log",
  "git_show", "view_image", "notebook_edit", "repo_map", "find_symbol",
];
const tools = (names: readonly string[] = ALL_TOOLS) => names.map((name) => ({ name, effect: "none" })) as AgentTool[];
const names = (list: readonly AgentTool[]) => list.map((tool) => tool.name);

describe("token saver switch", () => {
  it("is on unless ARCHYMEDES_TOKEN_SAVER says off", () => {
    expect(tokenSaverEnabled({})).toBe(true);
    expect(tokenSaverEnabled({ ARCHYMEDES_TOKEN_SAVER: "on" })).toBe(true);
    expect(tokenSaverEnabled({ ARCHYMEDES_TOKEN_SAVER: " " })).toBe(true);
    for (const off of ["off", "OFF", "0", "false", "no", "disabled"]) expect(tokenSaverEnabled({ ARCHYMEDES_TOKEN_SAVER: off }), off).toBe(false);
  });
});

describe("token saver budgets", () => {
  it("budgets the free router's 32K window as 16K with small tool results", () => {
    expect(tokenSaverBudgets(capabilitiesFor("openrouter/free"))).toEqual({
      contextLimit: TOKEN_SAVER_CONTEXT_LIMIT, maxOutputTokens: 4_096,
      maxToolResultChars: TOKEN_SAVER_TOOL_RESULT_CHARS, maxTotalToolResultChars: TOKEN_SAVER_TOTAL_TOOL_RESULT_CHARS, maxToolCallsPerTurn: 8,
    });
  });

  it("never exceeds a smaller model's own limits", () => {
    const small = tokenSaverBudgets({ contextWindow: 8_192, maxOutputTokens: 1_024, supportsEffort: false });
    expect(small).toMatchObject({ contextLimit: 8_192, maxOutputTokens: 1_024, maxToolResultChars: 1_638, maxTotalToolResultChars: 16_384 });
    // The runtime's validator floors (256 output tokens, 128 result chars) still hold for a tiny model.
    expect(tokenSaverBudgets({ contextWindow: 1_000, maxOutputTokens: 100, supportsEffort: false })).toMatchObject({ maxOutputTokens: 256, maxToolResultChars: 200 });
  });
});

describe("lean tool set", () => {
  it("drops the rarely needed, expensive-to-describe tools for an ordinary request", () => {
    const kept = names(leanToolset(tools(), "build", "fix the failing parser test"));
    expect(kept).toEqual(expect.arrayContaining(["read_file", "edit_file", "write_file", "run_command", "grep_files", "git_status", "git_diff", "todo_write", "compute"]));
    for (const dropped of ["web_search", "deep_research", "web_fetch", "deploy_app", "notebook_edit", "view_image", "repo_map", "find_symbol",
      "git_log", "git_show", "scan_secrets", "todo_read", "delegate_task", "delegate_readonly_task", "query_defensive_brain", "read_playbook", "remember", "application_status"]) {
      expect(kept, dropped).not.toContain(dropped);
    }
  });

  it("brings a tool back when the request asks for what it does", () => {
    const has = (objective: string, tool: string) => names(leanToolset(tools(), "build", objective)).includes(tool);
    expect(has("look up the latest docs for vitest", "web_search")).toBe(true);
    expect(has("summarize https://example.com/page", "web_fetch")).toBe(true);
    expect(has("research how other CLIs do this", "deep_research")).toBe(true);
    expect(has("deploy it to vercel", "deploy_app")).toBe(true);
    expect(has("clean up analysis.ipynb", "notebook_edit")).toBe(true);
    expect(has("what is in screenshot.png?", "view_image")).toBe(true);
    expect(has("what changed in the last commit?", "git_show")).toBe(true);
    expect(has("check for leaked api keys", "scan_secrets")).toBe(true);
    expect(has("where is parseConfig defined?", "find_symbol")).toBe(true);
    expect(has("remember that we use pnpm", "remember")).toBe(true);
    expect(has("run these in parallel with sub-agents", "delegate_task")).toBe(true);
    expect(has("anything", "todo_read")).toBe(false);
  });

  it("keeps defender mode's own tools and every user-configured tool", () => {
    const defender = names(leanToolset(tools(), "defender", "audit the auth module"));
    expect(defender).toEqual(expect.arrayContaining(["query_defensive_brain", "read_playbook", "scan_secrets", "web_search", "web_fetch"]));
    const external = [{ name: "web_search", effect: "none", provenance: { kind: "mcp" } }] as unknown[] as AgentTool[];
    expect(names(leanToolset(external, "build", "fix it"))).toEqual(["web_search"]);
  });

  it("leaves a chat-only (empty) tool set empty", () => {
    expect(leanToolset([], "build", "hello")).toEqual([]);
  });
});

describe("earlier tool results as stubs", () => {
  const bigFile = `export const value = 1;\n${"// filler line\n".repeat(200)}`;
  const history: AgentMessage[] = [
    { role: "user", content: "read the parser" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/parser.ts" } }, { id: "c2", name: "run_command", arguments: { command: "npm test" } }] },
    { role: "tool", toolCallId: "c1", name: "read_file", content: bigFile },
    { role: "tool", toolCallId: "c2", name: "run_command", content: "exit code 0" },
    { role: "assistant", content: "It exports one value." },
    { role: "user", content: "rewrite it" },
    { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "write_file", arguments: { path: "src/parser.ts", content: "x".repeat(5_000) } }] },
    { role: "tool", toolCallId: "c3", name: "write_file", content: "Error: permission denied ".repeat(40) },
    { role: "assistant", content: "Could not write it." },
  ];

  it("stubs long results and long call arguments while keeping every call paired with its result", () => {
    const sent = stubEarlierToolResults(history);
    expect(sent).toHaveLength(history.length);
    expect(() => validateHistory(sent)).not.toThrow();
    const read = sent[2] as Extract<AgentMessage, { role: "tool" }>;
    expect(read).toMatchObject({ role: "tool", toolCallId: "c1", name: "read_file" });
    expect(read.content).toBe(earlierToolResultStub("read_file", bigFile));
    expect(read.content).toContain(`${bigFile.length} chars`);
    expect(read.content).toContain("export const value = 1;");
    expect(read.content.length).toBeLessThan(300);
    // Short results and errors are worth more than a stub would save.
    expect(sent[3]).toBe(history[3]);
    expect(sent[7]).toBe(history[7]);
    // A whole file passed to write_file is elided; the short path argument is kept.
    const write = sent[6] as Extract<AgentMessage, { toolCalls: unknown }>;
    expect(write.toolCalls[0]).toMatchObject({ id: "c3", name: "write_file", arguments: { path: "src/parser.ts", content: "[5000 chars omitted from an earlier turn]" } });
    expect(sent[1]).toBe(history[1]);
    expect(JSON.stringify(sent).length).toBeLessThan(JSON.stringify(history).length / 4);
  });

  it("drops images from a stubbed result", () => {
    const withImage: AgentMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "i1", name: "view_image", arguments: { path: "a.png" } }] },
      { role: "tool", toolCallId: "i1", name: "view_image", content: "caption ".repeat(100), images: [{ path: "a.png", mediaType: "image/png", data: "AAAA" }] },
    ] as AgentMessage[];
    expect(stubEarlierToolResults(withImage)[1]).not.toHaveProperty("images");
  });

  it("leaves a history with nothing large untouched", () => {
    const small: AgentMessage[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const sent = stubEarlierToolResults(small);
    expect(sent).toEqual(small);
    expect(sent[0]).toBe(small[0]);
  });

  it("puts the full history back into the runtime's transcript", () => {
    const sent = stubEarlierToolResults(history);
    const turn: AgentMessage[] = [{ role: "user", content: "now test it" }, { role: "assistant", content: "Done." }];
    const runtime: AgentMessage[] = [{ role: "system", content: "prompt" }, ...sent, ...turn];
    expect(restoreFullHistory(runtime, history, sent)).toEqual([{ role: "system", content: "prompt" }, ...history, ...turn]);
    // Not the shape it expects: returned as given rather than guessed at.
    expect(restoreFullHistory(turn, history, sent)).toEqual(turn);
    expect(restoreFullHistory(runtime, history.slice(1), sent)).toEqual(runtime);
  });
});
