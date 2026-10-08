import { describe, expect, it } from "vitest";
import { DiagnosticsCollection, parsePublishDiagnostics, severityName } from "./diagnostics";
import type { LspDiagnostic, LspDiagnosticSeverity, PublishDiagnosticsParams } from "./protocol";

const diagnostic = (message: string, severity: LspDiagnosticSeverity = 1, line = 0): LspDiagnostic => ({
  range: { start: { line, character: 0 }, end: { line, character: 5 } },
  severity,
  message,
});

describe("severityName", () => {
  it("names each of the four severities", () => {
    expect(severityName(1)).toBe("error");
    expect(severityName(2)).toBe("warning");
    expect(severityName(3)).toBe("information");
    expect(severityName(4)).toBe("hint");
  });

  it("treats a missing severity as an error, the cautious reading", () => {
    expect(severityName(undefined)).toBe("error");
  });
});

describe("parsePublishDiagnostics", () => {
  it("passes a well-formed payload through", () => {
    const params = {
      uri: "file:///src/a.ts",
      version: 3,
      diagnostics: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }, severity: 2, source: "typescript", message: "Unused variable" }],
    };
    expect(parsePublishDiagnostics(params)).toEqual({
      uri: "file:///src/a.ts",
      version: 3,
      diagnostics: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }, severity: 2, source: "typescript", message: "Unused variable" }],
    });
  });

  it("accepts a payload with no version and no severity, which the protocol allows", () => {
    const parsed = parsePublishDiagnostics({ uri: "file:///a.py", diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "bare" }] });
    expect(parsed.version).toBeUndefined();
    expect(parsed.diagnostics[0].severity).toBeUndefined();
  });

  it("rejects a payload whose uri is missing or not a string", () => {
    expect(() => parsePublishDiagnostics({ diagnostics: [] })).toThrow(/uri must be a non-empty string/);
    expect(() => parsePublishDiagnostics({ uri: "", diagnostics: [] })).toThrow(/uri must be a non-empty string/);
    expect(() => parsePublishDiagnostics(null)).toThrow(/must be an object/);
  });

  it("rejects a payload whose diagnostics are not an array", () => {
    expect(() => parsePublishDiagnostics({ uri: "file:///a.ts", diagnostics: "many" })).toThrow(/diagnostics must be an array/);
  });

  it("rejects a diagnostic with no message, a bad range, or a severity outside 1-4", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    expect(() => parsePublishDiagnostics({ uri: "file:///a.ts", diagnostics: [{ range }] })).toThrow(/message must be a non-empty string/);
    expect(() => parsePublishDiagnostics({ uri: "file:///a.ts", diagnostics: [{ message: "x", range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } }] })).toThrow(/line must be a non-negative integer/);
    expect(() => parsePublishDiagnostics({ uri: "file:///a.ts", diagnostics: [{ message: "x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 9 }] })).toThrow(/severity must be an integer between 1 and 4/);
    expect(() => parsePublishDiagnostics({ uri: "file:///a.ts", diagnostics: [{ message: "x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, code: {} }] })).toThrow(/code must be a number or a string/);
  });
});

describe("DiagnosticsCollection", () => {
  const params = (uri: string, diagnostics: LspDiagnostic[]): PublishDiagnosticsParams => ({ uri, diagnostics });

  it("replaces the diagnostics for a document instead of merging into them", () => {
    const collection = new DiagnosticsCollection();
    collection.publish(params("file:///a.ts", [diagnostic("first")]));
    collection.publish(params("file:///a.ts", [diagnostic("second"), diagnostic("third", 2)]));
    expect(collection.get("file:///a.ts").map((item) => item.message)).toEqual(["second", "third"]);
  });

  it("returns an empty list for a document nothing was published for", () => {
    const collection = new DiagnosticsCollection();
    expect(collection.get("file:///never.ts")).toEqual([]);
  });

  it("clears one document by uri, or everything with no argument", () => {
    const collection = new DiagnosticsCollection();
    collection.publish(params("file:///a.ts", [diagnostic("a")]));
    collection.publish(params("file:///b.ts", [diagnostic("b")]));
    collection.clear("file:///a.ts");
    expect(collection.uris()).toEqual(["file:///b.ts"]);
    collection.clear();
    expect(collection.uris()).toEqual([]);
  });

  it("lists every document with diagnostics, sorted by uri", () => {
    const collection = new DiagnosticsCollection();
    collection.publish(params("file:///z.ts", [diagnostic("z")]));
    collection.publish(params("file:///a.ts", [diagnostic("a")]));
    expect(collection.all().map((entry) => entry.uri)).toEqual(["file:///a.ts", "file:///z.ts"]);
  });

  it("tallies by severity, counting an omitted severity as an error", () => {
    const collection = new DiagnosticsCollection();
    collection.publish(params("file:///a.ts", [
      diagnostic("e1", 1),
      diagnostic("e2"),
      diagnostic("w1", 2),
      diagnostic("i1", 3),
      diagnostic("h1", 4),
      diagnostic("h2", 4),
    ]));
    expect(collection.counts()).toEqual({ error: 2, warning: 1, information: 1, hint: 2, total: 6 });
  });

  it("counts an empty collection as zero across the board", () => {
    expect(new DiagnosticsCollection().counts()).toEqual({ error: 0, warning: 0, information: 0, hint: 0, total: 0 });
  });
});
