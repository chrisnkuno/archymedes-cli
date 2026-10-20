import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentModelRequest, AgentModelTurn, AgentTool, AgentTurnProvider } from "../agent-runtime";
import { ArchymedesAgent, type ArchymedesEvent } from "./agent";
import { LocalWorkspace } from "./backends";
import { buildArchymedesSystemPrompt } from "./prompt";
import {
  BUILT_IN_SUBAGENTS,
  delegationGuidance,
  delegationTools,
  loadSubagentProfiles,
  parseSubagentFile,
  toolsForSubagent,
  type SubagentProfile,
} from "./subagents";
import { createArchymedesTools, TodoList } from "./tools";

let root: string;
const prices = { inputRatePerMillion: 2_000, outputRatePerMillion: 8_000 };
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-subagents-"));
  await fs.writeFile(path.join(root, "app.ts"), "export const port = 3000;\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const role = (name: string) => BUILT_IN_SUBAGENTS.find((profile) => profile.name === name)!;

describe("a role from a Markdown file", () => {
  it("reads name, description, tools, readonly, effort and the body as instructions", () => {
    const profile = parseSubagentFile("a.md", "---\nname: migrations\ndescription: \"Writes migrations\"\ntools: [read_file, write_file]\nreadonly: false\neffort: high\nmax-iterations: 99\n---\nUse the migrate script.\n");
    expect(profile).toMatchObject({ name: "migrations", description: "Writes migrations", tools: ["read_file", "write_file"], readOnly: false, effort: "high", instructions: "Use the migrate script.", source: "a.md" });
    // A file cannot lift a role past the ceiling.
    expect(profile.maxIterations).toBe(40);
  });

  it("refuses a file without front matter, a bad name, no description or an unknown effort, naming the file", () => {
    expect(() => parseSubagentFile("x.md", "just text")).toThrow(/x\.md.*front matter/);
    expect(() => parseSubagentFile("x.md", "---\nname: Bad Name\ndescription: d\n---\n")).toThrow(/x\.md.*name/);
    expect(() => parseSubagentFile("x.md", "---\nname: ok\n---\n")).toThrow(/x\.md.*description/);
    expect(() => parseSubagentFile("x.md", "---\nname: ok\ndescription: d\neffort: huge\n---\n")).toThrow(/x\.md.*effort/);
  });

  it("loads the person's roles, then the project's, a later one replacing a built-in by name, and reports a broken file", async () => {
    const config = path.join(root, "config");
    await fs.mkdir(path.join(config, "agents"), { recursive: true });
    await fs.writeFile(path.join(config, "agents", "docs.md"), "---\nname: docs\ndescription: writes docs\n---\nBe brief.\n");
    await fs.mkdir(path.join(root, ".archymedes", "agents"), { recursive: true });
    await fs.writeFile(path.join(root, ".archymedes", "agents", "explore.md"), "---\nname: explore\ndescription: project explore\nreadonly: true\n---\nStart in src/.\n");
    await fs.writeFile(path.join(root, ".archymedes", "agents", "broken.md"), "no front matter");
    const { profiles, problems } = await loadSubagentProfiles(new LocalWorkspace(root), config);
    const names = profiles.map((profile) => profile.name);
    expect(names).toEqual(expect.arrayContaining(["explore", "plan", "review", "general", "verify", "docs"]));
    expect(names.filter((name) => name === "explore")).toHaveLength(1);
    expect(profiles.find((profile) => profile.name === "explore")?.instructions).toBe("Start in src/.");
    expect(problems).toEqual([expect.stringContaining("broken.md")]);
  });
});

describe("what a sub-agent may call", () => {
  async function parentTools(): Promise<AgentTool[]> {
    return createArchymedesTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      ask: async () => null,
      delegate: async () => ({ report: "", status: "completed", iterations: 0, toolCallsExecuted: 0 }),
    });
  }
  const readOnlyCapabilities = ["workspace.files.read", "workspace.search", "planning"];

  it("never offers delegation, the todo list, questions, memory or deployment, in any role", async () => {
    const tools = await parentTools();
    for (const profile of BUILT_IN_SUBAGENTS) {
      const names = toolsForSubagent(profile, tools, readOnlyCapabilities).map((tool) => tool.name);
      for (const name of ["delegate_task", "delegate_readonly_task", "todo_write", "todo_read", "ask_user", "remember", "deploy_app"]) expect(names, profile.name).not.toContain(name);
    }
  });

  it("gives a read-only role only effect-free, parallel-safe tools, and verify commands but no edits", async () => {
    const tools = await parentTools();
    const explore = toolsForSubagent(role("explore"), tools, tools.map((tool) => tool.capabilityId));
    expect(explore.every((tool) => tool.effect === "none" && tool.parallelSafe)).toBe(true);
    expect(explore.map((tool) => tool.name)).toContain("grep_files");
    const verify = toolsForSubagent(role("verify"), tools, readOnlyCapabilities).map((tool) => tool.name);
    expect(verify).toContain("run_command");
    for (const name of ["write_file", "edit_file"]) expect(verify).not.toContain(name);
    const general = toolsForSubagent(role("general"), tools, readOnlyCapabilities).map((tool) => tool.name);
    expect(general).toEqual(expect.arrayContaining(["write_file", "edit_file", "run_command"]));
  });

  it("limits a custom role to the tools it lists", async () => {
    const custom: SubagentProfile = { ...role("general"), name: "reader", tools: ["read_file"], without: undefined, source: "x.md" };
    expect(toolsForSubagent(custom, await parentTools(), readOnlyCapabilities).map((tool) => tool.name)).toEqual(["read_file"]);
  });
});

describe("the delegation tools", () => {
  const delegate = async () => ({ report: "r", status: "completed", iterations: 1, toolCallsExecuted: 0 });

  it("offer read-only roles through delegate_readonly_task and the rest through delegate_task", () => {
    const tools = delegationTools(delegate);
    const enumOf = (name: string) => ((tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, { enum?: string[] }>).agent.enum);
    expect(enumOf("delegate_readonly_task")).toEqual(["explore", "plan", "review"]);
    expect(enumOf("delegate_task")).toEqual(["general", "verify"]);
    expect(tools.find((tool) => tool.name === "delegate_readonly_task")?.parallelSafe).toBe(true);
    expect(tools.find((tool) => tool.name === "delegate_task")?.parallelSafe).toBe(false);
  });

  it("describe a custom role in the schema, since the prompt only explains the built-in ones", () => {
    const custom: SubagentProfile = { ...role("explore"), name: "docs", description: "reads the docs site", source: "docs.md" };
    const tool = delegationTools(delegate, [...BUILT_IN_SUBAGENTS, custom]).find((candidate) => candidate.name === "delegate_readonly_task")!;
    expect(tool.description).toContain("docs (reads the docs site)");
    expect(tool.description).not.toContain(role("explore").description);
  });

  it("pass the role and the calling tool call through to the runner", async () => {
    const seen: unknown[] = [];
    const tools = delegationTools(async (task, options) => {
      seen.push({ task, ...options });
      return { report: "r", status: "completed", iterations: 1, toolCallsExecuted: 0 };
    });
    await tools.find((tool) => tool.name === "delegate_readonly_task")!.execute({ task: "find X", agent: "review" }, { taskId: "t", runId: "r", stepId: "s", toolCallId: "call_1" });
    expect(seen).toEqual([{ task: "find X", readOnly: true, agent: "review", toolCallId: "call_1" }]);
  });
});

describe("when to delegate", () => {
  it("is said only when a delegation tool is offered, in full and in lean prompts", () => {
    expect(delegationGuidance(["read_file"])).toBe("");
    expect(delegationGuidance(["delegate_readonly_task"])).toContain("explore");
    expect(delegationGuidance(["delegate_readonly_task"])).not.toContain("delegate_task:");
    const context = { root, layout: [], packageScripts: [] } as unknown as Parameters<typeof buildArchymedesSystemPrompt>[0];
    expect(buildArchymedesSystemPrompt(context, "build", ["read_file", "delegate_task", "delegate_readonly_task"])).toContain("Sub-agents");
    expect(buildArchymedesSystemPrompt(context, "build", ["read_file", "delegate_task"], undefined, undefined, { lean: true })).toContain("Sub-agents: delegate only");
    expect(buildArchymedesSystemPrompt(context, "build", ["read_file"])).not.toContain("Sub-agents");
  });
});

describe("a sub-agent in a session", () => {
  /** Routes requests by whether they come from the parent (it has the delegation tools) or a sub-agent. */
  function routedModel(parent: Array<Partial<AgentModelTurn>>, child: (request: AgentModelRequest) => Promise<Partial<AgentModelTurn>>) {
    const requests: AgentModelRequest[] = [];
    let parentIndex = 0;
    const model: AgentTurnProvider = {
      async complete(request) {
        requests.push(request);
        const base = { responseId: "r", model: "test", finishReason: "stop", content: "", toolCalls: [], usage };
        if (request.tools.some((tool) => tool.name === "delegate_readonly_task" || tool.name === "delegate_task")) {
          return { ...base, ...parent[Math.min(parentIndex++, parent.length - 1)] } as AgentModelTurn;
        }
        return { ...base, ...(await child(request)) } as AgentModelTurn;
      },
    };
    return { model, requests };
  }

  it("runs the role asked for, with its instructions and the report contract, and shows its calls under the delegation call", async () => {
    let childTurn = 0;
    const { model, requests } = routedModel(
      [
        { finishReason: "tool_calls", toolCalls: [{ id: "d1", name: "delegate_readonly_task", arguments: { task: "review app.ts", agent: "review" } }] },
        { content: "Reviewed." },
      ],
      async () => (childTurn++ === 0
        ? { finishReason: "tool_calls", toolCalls: [{ id: "s1", name: "read_file", arguments: { path: "app.ts" } }] }
        : { content: "No defects found in app.ts:1." }),
    );
    const events: ArchymedesEvent[] = [];
    const agent = new ArchymedesAgent({ root, model, prices, mode: "build", approve: async () => "allow", onEvent: (event) => events.push(event) });
    const result = await agent.send("review app.ts for bugs");
    expect(result.status).toBe("completed");

    const childSystem = String(requests.find((request) => !request.tools.some((tool) => tool.name.startsWith("delegate_")))?.messages.find((message) => message.role === "system")?.content);
    expect(childSystem).toContain("You are a review sub-agent");
    expect(childSystem).toContain("your final message is the only thing");

    const sub = events.filter((event): event is Extract<ArchymedesEvent, { type: "subagent" }> => event.type === "subagent");
    expect(sub.every((event) => event.parentToolCallId === "d1" && event.agent === "review")).toBe(true);
    expect(sub.map((event) => event.event.type)).toEqual(expect.arrayContaining(["tool_call", "tool_result", "model_turn"]));
    const delegated = events.find((event) => event.type === "runtime" && event.event.type === "tool_result" && event.event.toolCallId === "d1");
    expect(delegated && delegated.type === "runtime" && delegated.event.type === "tool_result" && delegated.event.content).toContain("No defects found");
    await agent.dispose();
  });

  it("refuses a writable role asked for through the read-only tool, and an unknown role, naming the roles", async () => {
    const { model } = routedModel(
      [
        { finishReason: "tool_calls", toolCalls: [
          { id: "d1", name: "delegate_readonly_task", arguments: { task: "x", agent: "general" } },
          { id: "d2", name: "delegate_task", arguments: { task: "x", agent: "nobody" } },
        ] },
        { content: "ok" },
      ],
      async () => ({ content: "never" }),
    );
    const events: ArchymedesEvent[] = [];
    const agent = new ArchymedesAgent({ root, model, prices, mode: "build", approve: async () => "allow", onEvent: (event) => events.push(event) });
    await agent.send("delegate these");
    const results = events.flatMap((event) => (event.type === "runtime" && event.event.type === "tool_result" ? [event.event] : []));
    // The read-only tool's schema lists only read-only roles, so "general" is refused before it runs.
    expect(results.find((entry) => entry.toolCallId === "d1")?.isError).toBe(true);
    const unknown = results.find((entry) => entry.toolCallId === "d2");
    expect(unknown?.isError).toBe(true);
    expect(unknown?.content).toMatch(/general|verify/);
    await agent.dispose();
  });

  it("offers a project's own role, read from .archymedes/agents, and runs it with its instructions", async () => {
    await fs.mkdir(path.join(root, ".archymedes", "agents"), { recursive: true });
    await fs.writeFile(path.join(root, ".archymedes", "agents", "ports.md"), "---\nname: ports\ndescription: knows the port config\nreadonly: true\n---\nPorts live in app.ts.\n");
    const { model, requests } = routedModel(
      [
        { finishReason: "tool_calls", toolCalls: [{ id: "d1", name: "delegate_readonly_task", arguments: { task: "which port?", agent: "ports" } }] },
        { content: "3000" },
      ],
      async () => ({ content: "3000, app.ts:1" }),
    );
    const agent = new ArchymedesAgent({ root, model, prices, mode: "build", approve: async () => "allow" });
    await agent.send("which port does the app use? check the whole codebase");
    const offered = requests[0].tools.find((tool) => tool.name === "delegate_readonly_task");
    expect(offered?.description).toContain("ports (knows the port config)");
    const childSystem = String(requests[1].messages.find((message) => message.role === "system")?.content);
    expect(childSystem).toContain("Ports live in app.ts.");
    await agent.dispose();
  });

  it("runs at most four at once; the rest wait their turn", async () => {
    let active = 0;
    let peak = 0;
    const calls = Array.from({ length: 6 }, (_, index) => ({ id: `d${index}`, name: "delegate_readonly_task", arguments: { task: `area ${index}` } }));
    const { model } = routedModel(
      [{ finishReason: "tool_calls", toolCalls: calls }, { content: "all in" }],
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return { content: "report" };
      },
    );
    const agent = new ArchymedesAgent({ root, model, prices, mode: "build", approve: async () => "allow", budgets: { maxToolCallsPerTurn: 10 } });
    const result = await agent.send("explore six areas in parallel");
    expect(result.status).toBe("completed");
    expect(peak).toBe(4);
    await agent.dispose();
  });
});
