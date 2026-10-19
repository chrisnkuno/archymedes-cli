import { describe, expect, it } from "vitest";
import { aliasTarget, normalizeToolName, resolveToolCall } from "./tool-aliases";
import { unavailableToolMessage } from "./tool-call-feedback";

const ALL = new Set(["read_file", "list_files", "glob_files", "grep_files", "write_file", "edit_file", "run_command", "web_search", "web_fetch", "todo_write"]);
const resolve = (name: string, args: unknown, available: ReadonlySet<string> = ALL) => resolveToolCall({ id: "c1", name, arguments: args }, available);
const aliased = (name: string, args: unknown) => {
  const result = resolve(name, args);
  return result.kind === "alias" ? { name: result.call.name, arguments: result.call.arguments } : result.kind;
};

describe("tool aliases", () => {
  it("leaves our own names alone", () => {
    expect(resolve("read_file", { path: "a" })).toEqual({ kind: "exact" });
  });

  it("strips namespaces and normalizes case", () => {
    expect(normalizeToolName("ReadFile")).toBe("read_file");
    expect(normalizeToolName("read-file")).toBe("read_file");
    expect(aliased("functions.read_file", { path: "a" })).toEqual({ name: "read_file", arguments: { path: "a" } });
    expect(aliased("default_api.grep_files", { query: "x" })).toEqual({ name: "grep_files", arguments: { query: "x" } });
    expect(aliased("TodoWrite", { todos: [] })).toEqual({ name: "todo_write", arguments: { todos: [] } });
  });

  it("maps Claude Code's tool names and argument names", () => {
    expect(aliased("Bash", { command: "ls" })).toEqual({ name: "run_command", arguments: { command: "ls" } });
    expect(aliased("Read", { file_path: "src/a.ts" })).toEqual({ name: "read_file", arguments: { path: "src/a.ts" } });
    expect(aliased("Edit", { file_path: "a", old_string: "x", new_string: "y", replace_all: true }))
      .toEqual({ name: "edit_file", arguments: { path: "a", oldText: "x", newText: "y", replaceAll: true } });
    expect(aliased("Write", { file_path: "a", content: "" })).toEqual({ name: "write_file", arguments: { path: "a", content: "" } });
    expect(aliased("Grep", { pattern: "TODO", glob: "*.ts" })).toEqual({ name: "grep_files", arguments: { query: "TODO", include: "*.ts" } });
    expect(aliased("Glob", { pattern: "**/*.go" })).toEqual({ name: "glob_files", arguments: { pattern: "**/*.go" } });
  });

  it("maps gpt-oss's built-in tools", () => {
    expect(aliased("container.exec", { cmd: ["bash", "-lc", "go test ./..."] })).toEqual({ name: "run_command", arguments: { command: "go test ./..." } });
    expect(aliased("container.exec", { cmd: ["ls", "-la", "my dir"] })).toEqual({ name: "run_command", arguments: { command: "ls -la 'my dir'" } });
    expect(aliased("browser.search", { query: "bubble tea" })).toEqual({ name: "web_search", arguments: { query: "bubble tea" } });
    expect(aliased("browser.open", { url: "https://x.dev" })).toEqual({ name: "web_fetch", arguments: { url: "https://x.dev" } });
  });

  it("maps Anthropic's text editor by its command", () => {
    expect(aliased("str_replace_based_edit_tool", { command: "view", path: "a" })).toEqual({ name: "read_file", arguments: { path: "a" } });
    expect(aliased("str_replace_based_edit_tool", { command: "create", path: "a", file_text: "x" })).toEqual({ name: "write_file", arguments: { path: "a", content: "x" } });
    expect(aliased("str_replace_editor", { command: "str_replace", path: "a", old_str: "x", new_str: "y" })).toEqual({ name: "edit_file", arguments: { path: "a", oldText: "x", newText: "y" } });
    expect(resolve("str_replace_based_edit_tool", { command: "undo_edit", path: "a" })).toEqual({ kind: "unknown" });
  });

  it("refuses rather than guesses when the arguments do not carry what our tool needs", () => {
    expect(resolve("Edit", { file_path: "a" })).toEqual({ kind: "unknown" });
    expect(resolve("Bash", {})).toEqual({ kind: "unknown" });
    expect(resolve("apply_patch", { input: "*** Begin Patch" })).toEqual({ kind: "unknown" });
    expect(resolve("python", { code: "print(1)" })).toEqual({ kind: "unknown" });
  });

  it("never translates into a tool this run may not call", () => {
    const readOnly = new Set(["read_file", "grep_files"]);
    expect(resolve("Bash", { command: "rm -rf x" }, readOnly)).toEqual({ kind: "unknown" });
    expect(resolve("Read", { file_path: "a" }, readOnly)).toMatchObject({ kind: "alias" });
  });
});

describe("tool aliases, end to end", () => {
  // A model that only knows another harness's tools does real work in a real project: every call
  // is translated, runs as ours, and changes the files on disk.
  it("reads, edits and runs through borrowed names in a real workspace", async () => {
    const { promises: fs } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { BoundedAgentRuntime } = await import("./agent-runtime");
    const { LocalWorkspace } = await import("./cli/backends");
    const { createArchymedesTools, TodoList } = await import("./cli/tools");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-aliases-"));
    try {
      await fs.writeFile(path.join(root, "greeting.txt"), "hello teh world\n");
      const tools = await createArchymedesTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
      const script = [
        [{ id: "1", name: "Read", arguments: { file_path: "greeting.txt" } }],
        [{ id: "2", name: "Edit", arguments: { file_path: "greeting.txt", old_string: "teh", new_string: "the" } }],
        [{ id: "3", name: "container.exec", arguments: { cmd: ["bash", "-lc", "cat greeting.txt"] } }],
        [{ id: "4", name: "functions.grep_files", arguments: { query: "the world" } }],
      ];
      const results: Record<string, string> = {};
      let step = 0;
      const runtime = new BoundedAgentRuntime({
        tools,
        prices: { inputRatePerMillion: 1, outputRatePerMillion: 1 },
        model: {
          async complete(request) {
            for (const message of request.messages) if (message.role === "tool") results[message.toolCallId] = message.content;
            const calls = script[step++];
            return calls
              ? { responseId: `r${step}`, model: "m", finishReason: "tool_calls", content: "", toolCalls: calls, usage }
              : { responseId: "done", model: "m", finishReason: "stop", content: "Fixed the typo.", toolCalls: [], usage };
          },
        },
        control: {
          async heartbeat() {},
          async isCancellationRequested() { return false; },
          async isToolCallApproved() { return true; },
          async persistEvent() {},
        },
      });
      const result = await runtime.execute({
        taskId: "t", runId: "r", stepId: "s", objective: "fix the typo", systemPrompt: "system",
        allowedCapabilityIds: [...new Set(tools.map((tool) => tool.capabilityId))], maxIterations: 8, maxToolCalls: 8, maxToolCallsPerTurn: 2,
        maxToolResultChars: 2_000, maxTotalToolResultChars: 8_000, maxOutputTokens: 500, modelReservationRwf: 1_000_000, safetyIdentifier: "x",
      });
      expect(result.toolCallsExecuted).toBe(4);
      expect(results["1"]).toContain("hello teh world");
      expect(results["2"]).toMatch(/Edited greeting\.txt/);
      expect(results["3"]).toContain("hello the world");
      expect(results["4"]).toContain("greeting.txt");
      expect(await fs.readFile(path.join(root, "greeting.txt"), "utf8")).toBe("hello the world\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("says what a habitual name means here when its arguments did not fit, instead of that it does not exist", () => {
    // Told "there is no tool named Edit", a model trained on Edit calls Edit again, and the second
    // time ends the run. Told what Edit is here and what it takes, its next call is right.
    expect(aliasTarget("Edit", ALL)).toBe("edit_file");
    expect(aliasTarget("functions.Bash", ALL)).toBe("run_command");
    expect(aliasTarget("Bash", new Set(["read_file"]))).toBeUndefined(); // not in this run: the mode's answer stands
    expect(aliasTarget("str_replace_based_edit_tool", ALL)).toBeUndefined(); // one name, three tools
    expect(aliasTarget("bogus", ALL)).toBeUndefined();
    const tools = [
      { name: "edit_file", description: "Edit", inputSchema: { type: "object", properties: { path: {}, oldText: {}, newText: {} }, required: ["path"] } },
      { name: "read_file", description: "Read", inputSchema: { type: "object", properties: {}, required: [] } },
    ];
    expect(unavailableToolMessage("Edit", false, tools)).toBe('"Edit" is edit_file here, but this call did not carry what edit_file needs. It needs path; it accepts path, oldText, newText. Call edit_file with those arguments.');
    expect(unavailableToolMessage("Read", false, tools)).toBe('"Read" is read_file here, but this call did not carry what read_file needs. Call read_file with those arguments.');
    expect(unavailableToolMessage("bogus", false, tools)).toMatch(/^There is no tool named "bogus"/);
    expect(unavailableToolMessage("edit_file", true, tools)).toMatch(/not allowed in this run/);
  });
});
