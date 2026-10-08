import { describe, expect, it } from "vitest";
import { runDiagnosticsCommand } from "./diagnostics";
import type { WorkspaceDiagnostics } from "@archymedes/core/lsp/collect";
import { UNICODE_GLYPHS } from "../text/glyphs";

function makeContext(result: WorkspaceDiagnostics) {
  const written: string[] = [];
  return {
    written,
    collect: async () => result,
    write: (text: string) => { written.push(text); },
    paint: {
      dim: (t: string) => t,
      green: (t: string) => t,
      yellow: (t: string) => t,
      red: (t: string) => t,
      cyan: (t: string) => t,
    },
    glyphs: UNICODE_GLYPHS,
    depth: "none" as const,
    width: 80,
  };
}

const emptyResult: WorkspaceDiagnostics = {
  servers: [],
  files: [],
  counts: { error: 0, warning: 0, information: 0, hint: 0, total: 0 },
};

const withDiagnostics: WorkspaceDiagnostics = {
  servers: [
    { server: { id: "typescript", command: "typescript-language-server", args: [], extensions: [], languageIds: [] }, ok: true, files: [] },
  ],
  files: [
    {
      path: "src/index.ts",
      diagnostics: [
        { range: { start: { line: 10, character: 4 }, end: { line: 10, character: 12 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'.", source: "typescript", code: 2322 },
        { range: { start: { line: 25, character: 0 }, end: { line: 25, character: 8 } }, severity: 2, message: "Unused variable 'x'.", source: "eslint" },
      ],
    },
  ],
  counts: { error: 1, warning: 1, information: 0, hint: 0, total: 2 },
};

describe("runDiagnosticsCommand", () => {
  it("reports no diagnostics when clean", async () => {
    const ctx = makeContext(emptyResult);
    await runDiagnosticsCommand(undefined, ctx);
    expect(ctx.written.join("\n")).toContain("No diagnostics");
  });

  it("renders diagnostics with severity and location", async () => {
    const ctx = makeContext(withDiagnostics);
    await runDiagnosticsCommand(undefined, ctx);
    const output = ctx.written.join("\n");
    expect(output).toContain("1 error");
    expect(output).toContain("1 warning");
    expect(output).toContain("src/index.ts");
    expect(output).toContain("ERROR");
    expect(output).toContain("11:5");
    expect(output).toContain("Type 'string' is not assignable to type 'number'.");
    expect(output).toContain("WARNING");
    expect(output).toContain("26:1");
    expect(output).toContain("Unused variable 'x'.");
  });

  it("reports unavailable servers", async () => {
    const result: WorkspaceDiagnostics = {
      ...emptyResult,
      servers: [
        { server: { id: "rust", command: "rust-analyzer", args: [], extensions: [], languageIds: [] }, ok: false, error: "rust-analyzer is not installed", files: [] },
      ],
    };
    const ctx = makeContext(result);
    await runDiagnosticsCommand(undefined, ctx);
    expect(ctx.written.join("\n")).toContain("rust-analyzer is not installed");
  });
});
