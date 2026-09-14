import { describe, expect, it } from "vitest";
import { describeFind, parseFindCommand } from "./find";

describe("/find", () => {
  it("parses a query, stepping, clearing and quoted keywords", () => {
    expect(parseFindCommand("/finder")).toBeNull();
    expect(parseFindCommand("/find")).toEqual({ kind: "next" });
    expect(parseFindCommand("/find next")).toEqual({ kind: "next" });
    expect(parseFindCommand("/find prev")).toEqual({ kind: "prev" });
    expect(parseFindCommand("/find off")).toEqual({ kind: "off" });
    expect(parseFindCommand("/find TypeError: x")).toEqual({ kind: "query", text: "TypeError: x" });
    expect(parseFindCommand('/find "off"')).toEqual({ kind: "query", text: "off" });
  });

  it("speaks only when the header does not already say it", () => {
    expect(describeFind({ status: "found", index: 1, total: 3, query: "x" })).toBeNull();
    expect(describeFind({ status: "cleared" })).toBeNull();
    expect(describeFind({ status: "none", query: "x" })).toBe('No match for "x".');
    expect(describeFind({ status: "idle" })).toContain("/find <text>");
    expect(describeFind(undefined)).toContain("fixed workspace");
  });
});
