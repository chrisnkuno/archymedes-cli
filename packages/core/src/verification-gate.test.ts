import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "./agent-runtime";
import { ArchymedesAgent, type ArchymedesEvent } from "./cli/agent";
import { LocalWorkspace } from "./cli/backends";
import { classifyPath, testFirstFromEnvironment, VerificationGate, type GateRecord, type TestFirstState } from "./verification-gate";

const write = (file: string): GateRecord => ({ toolName: "write_file", arguments: { path: file }, effect: "workspace", isError: false });
const passed = (kind: "check" | "tests" | "smoke" | "behavior"): GateRecord => ({ toolName: "run_command", arguments: { command: kind }, effect: "none", isError: false, verification: { passed: true, kind, scope: "targeted", summary: kind } });
const failedTests: GateRecord = { toolName: "run_command", arguments: { command: "npm test" }, effect: "none", isError: true, data: { verificationKind: "tests", exitCode: 1 } };

/** Asks the gate until it lets the run finish; the requests it made, in order. */
function drain(gate: VerificationGate): string[] {
  const asked: string[] = [];
  for (let next = gate.beforeFinish(); next; next = gate.beforeFinish()) asked.push(next);
  return asked;
}

describe("which files are tests", () => {
  it.each([
    "src/app.test.ts", "src/app.spec.tsx", "internal/tui/core_view_test.go", "tests/test_parser.py", "test_parser.py",
    "spec/models/user_spec.rb", "src/__tests__/app.ts", "e2e/login.ts", "src/test/java/AppTest.java", "C:\\repo\\tests\\a.py",
  ])("%s is a test", (file) => expect(classifyPath(file)).toBe("test"));

  it.each(["src/app.ts", "cmd/friday/main.go", "lib/parser.py", "src/App.vue", "scripts/build.sh", "src/main.rs"])("%s is code", (file) => {
    expect(classifyPath(file)).toBe("code");
  });

  it.each(["README.md", "package.json", "src/styles.css", "docs/testing.md", ".github/workflows/ci.yml", "index.html"])("%s is neither", (file) => {
    expect(classifyPath(file)).toBe("other");
  });
});

describe("the setting", () => {
  it("is on unless it says off", () => {
    expect(testFirstFromEnvironment({})).toBe(true);
    expect(testFirstFromEnvironment({ ARCHYMEDES_TEST_FIRST: "on" })).toBe(true);
    expect(testFirstFromEnvironment({ ARCHYMEDES_TEST_FIRST: "anything" })).toBe(true);
    for (const off of ["off", "OFF", " false ", "0", "no"]) expect(testFirstFromEnvironment({ ARCHYMEDES_TEST_FIRST: off })).toBe(false);
  });
});

describe("the gate, test first", () => {
  it("lets a run that changed nothing finish at once", () => {
    expect(drain(new VerificationGate(true))).toEqual([]);
  });

  it("lets the full order finish without asking anything: tests, red, code, green, checked", () => {
    const gate = new VerificationGate(true);
    gate.record(write("src/sum.test.ts"));
    gate.record(failedTests);
    gate.record(write("src/sum.ts"));
    gate.record(passed("tests"));
    gate.record(passed("check"));
    expect(drain(gate)).toEqual([]);
    expect(gate.unverified).toBe(false);
    expect(gate.takeState()).toEqual({ tests: ["src/sum.test.ts"], code: ["src/sum.ts"], red: true, green: true, checked: true });
  });

  it("asks for tests, then evidence, then static analysis, each exactly once, when code changed alone", () => {
    const gate = new VerificationGate(true);
    gate.record(write("src/sum.ts"));
    const asked = drain(gate);
    expect(asked).toHaveLength(3);
    expect(asked[0]).toMatch(/without writing a test/);
    expect(asked[1]).toMatch(/without running anything that verifies it/);
    expect(asked[2]).toMatch(/static analysis/);
    // Each has an honest "no": asked once, never again in the run.
    expect(gate.beforeFinish()).toBeUndefined();
    expect(gate.unverified).toBe(true);
  });

  it("holds tests and checks to the last code change: an edit after green makes both stale", () => {
    const gate = new VerificationGate(true);
    gate.record(write("src/a.test.ts"));
    gate.record(write("src/a.ts"));
    gate.record(passed("tests"));
    gate.record(passed("check"));
    gate.record(write("src/a.ts"));
    expect(gate.takeState()).toMatchObject({ green: false, checked: false });
    gate.record(passed("tests"));
    expect(drain(gate)).toEqual([expect.stringMatching(/static analysis/)]);
  });

  it("counts red only for a failing test run after tests and before any code", () => {
    const before = new VerificationGate(true);
    before.record(failedTests); // no test written yet
    before.record(write("src/a.test.ts"));
    expect(before.takeState()?.red).toBe(false);
    const after = new VerificationGate(true);
    after.record(write("src/a.test.ts"));
    after.record(write("src/a.ts"));
    after.record(failedTests); // code already changed: a failure, not the test biting
    expect(after.takeState()?.red).toBe(false);
  });

  it("notes code written before any test once, on that result", () => {
    const gate = new VerificationGate(true);
    expect(gate.record(write("src/a.ts"))).toMatch(/Test first/);
    expect(gate.record(write("src/b.ts"))).toBeUndefined();
    const testsFirst = new VerificationGate(true);
    testsFirst.record(write("src/a.test.ts"));
    expect(testsFirst.record(write("src/a.ts"))).toBeUndefined();
  });

  it("holds docs and configuration only to the ordinary evidence rule", () => {
    const gate = new VerificationGate(true);
    expect(gate.record(write("README.md"))).toBeUndefined();
    expect(drain(gate)).toEqual([expect.stringMatching(/without running anything/)]);
    expect(gate.takeState()).toBeUndefined();
  });

  it("reports its state only when it changed", () => {
    const gate = new VerificationGate(true);
    gate.record(write("src/a.test.ts"));
    expect(gate.takeState()).toBeDefined();
    expect(gate.takeState()).toBeUndefined();
    gate.record(passed("tests"));
    expect(gate.takeState()?.green).toBe(true);
  });
});

describe("the gate, test first off", () => {
  it("asks only what it always asked: evidence, then executed tests over a compile", () => {
    const gate = new VerificationGate(false);
    expect(gate.record(write("src/a.ts"))).toBeUndefined();
    gate.record(passed("check"));
    expect(drain(gate)).toEqual([expect.stringMatching(/compiles, not that it behaves/)]);
    expect(gate.takeState()).toBeUndefined();
  });
});

describe("a build turn, test first", () => {
  let root: string;
  const prices = { inputRatePerMillion: 2_000, outputRatePerMillion: 8_000 };
  const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-test-first-"));
    await fs.writeFile(path.join(root, "sum.ts"), "export const sum = (a: number, b: number) => a - b;\n");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function scripted(turns: Array<Partial<AgentModelTurn>>): AgentTurnProvider & { requests: AgentModelRequest[] } {
    const requests: AgentModelRequest[] = [];
    let index = 0;
    return {
      requests,
      async complete(request) {
        requests.push(request);
        const turn = turns[Math.min(index++, turns.length - 1)];
        return { responseId: `r${index}`, model: "test", finishReason: "stop", content: "Done.", toolCalls: [], usage, ...turn } as AgentModelTurn;
      },
    };
  }

  function agentFor(model: AgentTurnProvider, events: ArchymedesEvent[], options: { testFirst?: boolean; mode?: "build" | "plan" } = {}) {
    return new ArchymedesAgent({
      root, model, prices, mode: options.mode ?? "build", approve: async () => "allow",
      ...(options.testFirst === undefined ? {} : { testFirst: options.testFirst }),
      onEvent: (event) => events.push(event),
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
      // A test run fails while sum.ts still subtracts, as the real one would; everything else passes.
      workspace: new LocalWorkspace(root, undefined, async (command) => {
        const buggy = (await fs.readFile(path.join(root, "sum.ts"), "utf8")).includes("a - b");
        const exitCode = /vitest|npm test/.test(command) && buggy ? 1 : 0;
        return { exitCode, stdout: exitCode === 0 ? "ok" : "1 failed", stderr: "" };
      }),
    });
  }

  it("tells the model to work test first, in build mode only, and not when switched off", async () => {
    const build = scripted([{ content: "hi" }]);
    await agentFor(build, []).send("fix sum.ts so it adds");
    const system = (model: { requests: AgentModelRequest[] }) => String(model.requests[0].messages.find((message) => message.role === "system")?.content);
    expect(system(build)).toContain("How to work: test first");
    const plan = scripted([{ content: "plan" }]);
    await agentFor(plan, [], { mode: "plan" }).send("fix sum.ts so it adds");
    expect(system(plan)).not.toContain("test first");
    const off = scripted([{ content: "hi" }]);
    await agentFor(off, [], { testFirst: false }).send("fix sum.ts so it adds");
    expect(system(off)).not.toContain("test first");
    expect(system(off)).toContain("Every task runs the same loop");
  });

  it("runs tests → red → code → green → checks and finishes without being asked for anything", async () => {
    const events: ArchymedesEvent[] = [];
    const model = scripted([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "t", name: "write_file", arguments: { path: "sum.test.ts", content: "expect(sum(1, 2)).toBe(3)" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "red", name: "run_command", arguments: { command: "npx vitest run sum.test.ts" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c", name: "edit_file", arguments: { path: "sum.ts", oldText: "a - b", newText: "a + b" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "green", name: "run_command", arguments: { command: "npx vitest run sum.test.ts" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "lint", name: "run_command", arguments: { command: "npx tsc --noEmit" } }] },
      { content: "sum adds; 1 test written, failed then passed; tsc clean." },
    ]);
    const result = await agentFor(model, events).send("fix sum.ts so it adds");
    expect(result.status).toBe("completed");
    // Six model calls: nothing was sent back for a missing step.
    expect(model.requests).toHaveLength(6);
    const states = events.flatMap((event) => (event.type === "runtime" && event.event.type === "test_first" ? [event.event.state] : []));
    expect(states.at(-1)).toEqual<TestFirstState>({ tests: ["sum.test.ts"], code: ["sum.ts"], red: true, green: true, checked: true });
  });

  it("sends code written without a test back for tests, and then for a static check, before it may finish", async () => {
    const model = scripted([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c", name: "edit_file", arguments: { path: "sum.ts", oldText: "a - b", newText: "a + b" } }] },
      { content: "Fixed." },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "t", name: "write_file", arguments: { path: "sum.test.ts", content: "expect(sum(1, 2)).toBe(3)" } }, { id: "g", name: "run_command", arguments: { command: "npm test" } }] },
      { content: "Tests added and passing." },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "v", name: "run_command", arguments: { command: "npx tsc --noEmit" } }] },
      { content: "Fixed; tests and tsc pass." },
    ]);
    const result = await agentFor(model, []).send("fix sum.ts so it adds");
    expect(result.status).toBe("completed");
    const said = (index: number) => model.requests[index].messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    // The code-before-tests note rode with the edit's own result.
    expect(said(1)).toContain("[Test first: this changed code before any test");
    expect(said(2)).toContain("without writing a test");
    expect(said(4)).toContain("static analysis");
    expect(model.requests).toHaveLength(6);
  });
});
