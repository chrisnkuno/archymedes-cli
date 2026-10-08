import { describe, expect, it } from "vitest";
import { repairToolArguments, repairToolCalls } from "./tool-call-repair";

describe("free-model tool-call argument repair", () => {
  it("passes objects through and reads an empty string as no arguments", () => {
    const value = { path: "a.ts" };
    expect(repairToolArguments(value)).toBe(value);
    expect(repairToolArguments("")).toEqual({});
    expect(repairToolArguments("   ")).toEqual({});
  });

  it.each([
    ["trailing commas", '{"path": "a.ts", "lines": [1, 2,],}', { path: "a.ts", lines: [1, 2] }],
    ["a code fence", '```json\n{"path": "a.ts"}\n```', { path: "a.ts" }],
    ["a bare fence", '```\n{"path": "a.ts"}\n```', { path: "a.ts" }],
    ["single quotes", "{'path': 'a.ts'}", { path: "a.ts" }],
    ["a missing closing brace", '{"path": "a.ts"', { path: "a.ts" }],
    ["a missing brace after a nested object", '{"edit": {"old": "x", "new": "y"}', { edit: { old: "x", new: "y" } }],
    ["double-encoded JSON", JSON.stringify(JSON.stringify({ path: "a.ts" })), { path: "a.ts" }],
  ])("repairs %s", (_name, input, expected) => {
    expect(repairToolArguments(input)).toEqual(expected);
  });

  it("keeps a comma inside a string value", () => {
    expect(repairToolArguments('{"text": "a,}", }')).toEqual({ text: "a,}" });
  });

  it("leaves ambiguous or truncated input alone for the runtime to reject", () => {
    for (const input of ['{"path": "a.ts', "not json at all", '[1, 2]', "{'it's': 'x'}", "42", '{"a": 1}}']) {
      expect(repairToolArguments(input)).toBe(input);
    }
    expect(repairToolArguments(42)).toBe(42);
    expect(repairToolArguments(null)).toBe(null);
  });

  it("repairs each call of a turn and keeps unchanged calls identical", () => {
    const fine = { id: "1", name: "read_file", arguments: { path: "a.ts" } };
    const [kept, fixed] = repairToolCalls([fine, { id: "2", name: "search", arguments: "{'query': 'x',}" }]);
    expect(kept).toBe(fine);
    expect(fixed).toEqual({ id: "2", name: "search", arguments: { query: "x" } });
  });
});
