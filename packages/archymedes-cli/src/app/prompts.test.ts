import { describe, expect, it, vi } from "vitest";
import type { Interface } from "node:readline/promises";
import type { ApprovalPattern } from "@archymedes/core/cli/permissions";
import { approvalChoices, approvalDecisionFor, createApprovalPrompt, renderApprovalPreview } from "./prompts";

const plain = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(plain(String(chunk)));
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

/** Answers every question with `answer`, recording what was asked. */
function fakeReadline(answer: string, asked: string[] = []): Interface {
  return { question: async (query: string) => { asked.push(plain(query)); return answer; } } as unknown as Interface;
}

const pattern: ApprovalPattern = { kind: "command-prefix", prefix: "npm test", label: "always allow commands starting with \"npm test\"" };

describe("approval answers", () => {
  it("keeps every existing key working", () => {
    expect(approvalDecisionFor("")).toBe("allow");
    expect(approvalDecisionFor("y")).toBe("allow");
    expect(approvalDecisionFor(" YES ")).toBe("allow");
    expect(approvalDecisionFor("a")).toBe("allow_always");
    expect(approvalDecisionFor("always")).toBe("allow_always");
    expect(approvalDecisionFor("n")).toBe("deny");
    expect(approvalDecisionFor("no")).toBe("deny");
    expect(approvalDecisionFor("d")).toBe("deny_always");
    expect(approvalDecisionFor("whatever")).toBe("deny");
  });

  it("returns allow_pattern for p only when a pattern was offered", () => {
    expect(approvalDecisionFor("p", pattern)).toBe("allow_pattern");
    expect(approvalDecisionFor("P", pattern)).toBe("allow_pattern");
    expect(approvalDecisionFor("p")).toBe("deny");
  });

  it("lists the [p] choice with the pattern's label only when one is offered", () => {
    expect(approvalChoices()).toBe("[y]es / [n]o / [a]lways / [d]eny always: ");
    expect(approvalChoices(pattern)).toBe("[y]es / [n]o / [a]lways / [p] always allow commands starting with \"npm test\" / [d]eny always: ");
  });
});

describe("createApprovalPrompt with a pattern", () => {
  it("shows the extra choice and returns allow_pattern", async () => {
    const asked: string[] = [];
    const { restore } = captureStdout();
    const approve = createApprovalPrompt(fakeReadline("p", asked), true, () => undefined);
    const decision = await approve({ summary: "run npm test -- --watch", pattern });
    restore();
    expect(decision).toBe("allow_pattern");
    expect(asked[0]).toContain("[p] always allow commands starting with \"npm test\"");
  });

  it("asks the old question, and still honours a, when no pattern is offered", async () => {
    const asked: string[] = [];
    const { restore } = captureStdout();
    const approve = createApprovalPrompt(fakeReadline("a", asked), true, () => undefined);
    const decision = await approve({ summary: "run rm -rf build" });
    restore();
    expect(decision).toBe("allow_always");
    expect(asked[0]).not.toContain("[p]");
  });
});

describe("approval preview", () => {
  it("renders the single-edit form as one diff", () => {
    const text = plain(renderApprovalPreview({ toolName: "edit_file", path: "src/app.ts", oldText: "port = 3000", newText: "port = 8080" }) ?? "");
    expect(text).toContain("src/app.ts");
    expect(text).toContain("3000");
    expect(text).toContain("8080");
  });

  it("renders the multi-edit form as one diff per hunk, in order", () => {
    const text = plain(renderApprovalPreview({
      toolName: "edit_file",
      path: "src/app.ts",
      oldText: "port = 3000\n…\nhost = a",
      newText: "port = 8080\n…\nhost = b",
      edits: [{ oldText: "port = 3000", newText: "port = 8080" }, { oldText: "host = a", newText: "host = b", replaceAll: true }],
    }) ?? "");
    expect(text).toContain("src/app.ts (edit 1/2)");
    expect(text).toContain("src/app.ts (edit 2/2, all occurrences)");
    expect(text.indexOf("3000")).toBeLessThan(text.indexOf("host = a"));
    expect(text).toContain("8080");
    expect(text).toContain("host = b");
    // Per-hunk rendering, not the flattened joined form with its separator line.
    expect(text).not.toContain("…\n");
  });

  it("renders a one-element edits array like the single-edit form", () => {
    const text = plain(renderApprovalPreview({ toolName: "edit_file", path: "a.ts", oldText: "x", newText: "y", edits: [{ oldText: "x", newText: "y" }] }) ?? "");
    expect(text).toContain("a.ts");
    expect(text).not.toContain("edit 1/1");
  });
});
