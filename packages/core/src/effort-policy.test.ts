import { describe, expect, it } from "vitest";
import { classifyObjective, isShallowToolError, predictEffort, reasoningFromEnvironment, type EffortSignals, type ToolOutcome } from "./effort-policy";

const ok = (tool: string, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({ tool, isError: false, ...extra });
const fail = (tool: string, shallow = false): ToolOutcome => ({ tool, isError: true, shallow });
const at = (overrides: Partial<EffortSignals>): EffortSignals => ({
  iteration: 2, objective: "add a word count command to the CLI", lastResults: [], consecutiveFailures: 0, greenSinceEdit: false, ...overrides,
});

describe("classifyObjective", () => {
  it.each([
    ["hello", "trivial"],
    ["thanks!", "trivial"],
    ["what is 2+2", "trivial"],
    ["add a health check endpoint to server.js", "routine"],
    ["Create a small Node.js CLI in this directory with tests", "routine"],
    ["debug why the login test is flaky", "hard"],
    ["Running 'node --test' fails. Find out why and fix util.js", "hard"],
    ["the build is broken after the merge", "hard"],
    ["add error handling to the upload route", "routine"],
    ["refactor the session store to be async", "hard"],
    ["investigate the memory leak in the worker", "hard"],
    ["x".repeat(800), "hard"],
  ])("%s -> %s", (text, expected) => expect(classifyObjective(text)).toBe(expected));
});

describe("isShallowToolError", () => {
  it.each([
    "ecommerce/server.js does not exist",
    'glob_files has no parameter "path". It accepts: pattern.',
    "src is a directory, not a file",
    "oldText was not found in a.js. Closest line is 3",
    "path escapes the workspace root: /tmp/x",
  ])("%s is a mistake in the arguments", (message) => expect(isShallowToolError(message)).toBe(true));
  it("a failed command is not shallow", () => {
    expect(isShallowToolError("exit 1\nTAP version 13\nnot ok 1 - counts lines")).toBe(false);
  });
});

describe("predictEffort", () => {
  it("plans a trivial message with no reasoning, an ordinary request briefly, and leaves a hard one to the model", () => {
    expect(predictEffort(at({ iteration: 1, objective: "hello" })).effort).toBe("minimal");
    expect(predictEffort(at({ iteration: 1 })).effort).toBe("low");
    expect(predictEffort(at({ iteration: 1, objective: "debug why the build fails on windows" })).effort).toBeUndefined();
  });

  it("leaves a failed piece of work to the model's own default, and says so", () => {
    const one = predictEffort(at({ lastResults: [fail("run_command")], consecutiveFailures: 1 }));
    expect(one.effort).toBeUndefined();
    expect(one.reason).toContain("run_command failed");
    expect(predictEffort(at({ lastResults: [fail("run_command")], consecutiveFailures: 5 })).reason).toContain("5 failures in a row");
  });

  it("only corrects a mistake in the arguments", () => {
    expect(predictEffort(at({ lastResults: [fail("read_file", true)] })).effort).toBe("low");
  });

  it("acts without thinking after edits went through, and summarizes without thinking once verified", () => {
    expect(predictEffort(at({ lastResults: [ok("write_file"), ok("edit_file")] })).effort).toBe("minimal");
    expect(predictEffort(at({ lastResults: [ok("run_command", { verified: "tests" })], greenSinceEdit: true })).effort).toBe("minimal");
  });

  it("takes in what it read, more carefully on a hard task", () => {
    expect(predictEffort(at({ lastResults: [ok("read_file")] })).effort).toBe("low");
    expect(predictEffort(at({ objective: "investigate the memory leak", lastResults: [ok("grep_files")] })).effort).toBeUndefined();
  });

  it("keeps thinking about what it reads while something is still broken (debugging)", () => {
    expect(predictEffort(at({ lastResults: [ok("read_file")], unresolvedFailure: true })).effort).toBeUndefined();
    expect(predictEffort(at({ lastResults: [ok("read_file")], unresolvedFailure: false })).effort).toBe("low");
    // ...but an edit going through is still just the next step toward re-running the test.
    expect(predictEffort(at({ lastResults: [ok("edit_file")], unresolvedFailure: true })).effort).toBe("minimal");
  });

  it("a mixed batch is judged by its worst result", () => {
    expect(predictEffort(at({ lastResults: [ok("read_file"), fail("run_command")], consecutiveFailures: 1 })).effort).toBeUndefined();
    expect(predictEffort(at({ lastResults: [ok("write_file"), fail("read_file", true)] })).effort).toBe("low");
  });

  describe("Jev's reading of the task", () => {
    it("raises the floor while things are going fine, but never overrides the run's own evidence", () => {
      const fine = at({ lastResults: [ok("write_file")], difficultyHint: "hard" });
      expect(predictEffort(fine).effort).toBe("low");
      expect(predictEffort({ ...fine, greenSinceEdit: true }).effort).toBe("minimal");
      expect(predictEffort({ ...fine, lastResults: [fail("run_command")], consecutiveFailures: 1 }).effort).toBeUndefined();
    });
    it("lowers the ceiling for a routine task, except when it is failing", () => {
      expect(predictEffort(at({ iteration: 1, objective: "debug why the build fails", difficultyHint: "routine" })).effort).toBe("low");
      expect(predictEffort(at({ lastResults: [fail("run_command")], consecutiveFailures: 2, difficultyHint: "routine" })).effort).toBeUndefined();
      expect(predictEffort(at({ lastResults: [ok("read_file")], unresolvedFailure: true, difficultyHint: "routine" })).effort).toBeUndefined();
    });
    it("a task Jev calls hard is planned at the model's default on the first call", () => {
      expect(predictEffort(at({ iteration: 1, difficultyHint: "hard" })).effort).toBeUndefined();
    });
  });
});

describe("reasoningFromEnvironment", () => {
  it("accepts auto and the four fixed levels, in any case", () => {
    for (const value of ["auto", "minimal", "low", "medium", "high"]) expect(reasoningFromEnvironment({ ARCHYMEDES_REASONING: value.toUpperCase() })).toBe(value);
    // Claude Code's and Codex's deepest levels are this engine's deepest.
    for (const value of ["xhigh", "max"]) expect(reasoningFromEnvironment({ ARCHYMEDES_REASONING: value })).toBe("high");
  });
  it("ignores anything else", () => {
    for (const value of [undefined, "", "off", "fast"]) expect(reasoningFromEnvironment({ ARCHYMEDES_REASONING: value })).toBeUndefined();
  });
});
