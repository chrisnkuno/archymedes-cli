import { describe, expect, it } from "vitest";
import { CostLedger } from "@archymedes/core/cli/cost";
import { runSessionCommand } from "./acp-commands";

function session(overrides: Record<string, unknown> = {}) {
  const ledger = new CostLedger({ prices: { currency: "USD", inputPerMillion: 3_000_000, outputPerMillion: 15_000_000 }, display: "USD" });
  const undone: string[] = [];
  const agent = {
    diffPatch: async () => "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    diffStat: async () => " x | 2 +-",
    undo: async (scope: string) => { undone.push(scope); return { label: "fix the bug" }; },
    todos: [{ id: 1, text: "read the code", status: "done" }, { id: 2, text: "fix it", status: "in_progress" }],
    ...overrides,
  };
  return { ledger, undone, deps: { agent: agent as never, ledger } };
}

describe("session commands over acp", () => {
  it("reports cost from the ledger as plain text", async () => {
    const { ledger, deps } = session();
    ledger.record({ usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 } as never, iterations: 1, toolCalls: 0, elapsedMs: 10 });
    const result = await runSessionCommand("cost", "", deps);
    expect(result).toMatchObject({ kind: "text", text: expect.stringContaining("Session cost") });
    expect(JSON.stringify(result)).not.toContain("\\u001b");
  });

  it("returns the patch as data, the stat as text, and says when nothing changed", async () => {
    expect(await runSessionCommand("diff", "", session().deps)).toMatchObject({ kind: "diff", patch: expect.stringContaining("+b") });
    expect(await runSessionCommand("diff", "stat", session().deps)).toMatchObject({ kind: "text", text: " x | 2 +-" });
    expect(await runSessionCommand("diff", "", session({ diffPatch: async () => "  " }).deps)).toMatchObject({ kind: "text", text: expect.stringContaining("Nothing changed") });
  });

  it("undoes by scope and refuses an unknown one without undoing anything", async () => {
    const value = session();
    expect(await runSessionCommand("undo", "code", value.deps)).toMatchObject({ text: 'Reverted the files for "fix the bug".' });
    expect(await runSessionCommand("undo", "everything", value.deps)).toMatchObject({ kind: "error" });
    expect(value.undone).toEqual(["code"]);
    expect(await runSessionCommand("undo", "", session({ undo: async () => undefined }).deps)).toMatchObject({ text: "Nothing to undo." });
  });

  it("lists the plan, or says there is none", async () => {
    expect(await runSessionCommand("todos", "", session().deps)).toEqual({ kind: "todos", items: [{ text: "read the code", status: "done" }, { text: "fix it", status: "in_progress" }] });
    expect(await runSessionCommand("todos", "", session({ todos: [] }).deps)).toMatchObject({ text: "No plan yet." });
  });
});
