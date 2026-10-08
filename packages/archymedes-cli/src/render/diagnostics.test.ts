import { describe, expect, it } from "vitest";
import { renderDiagnostics } from "./diagnostics";
import type { WorkspaceDiagnostics } from "@archymedes/core/lsp/collect";
import { UNICODE_GLYPHS } from "../text/glyphs";

const context = {
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

describe("renderDiagnostics", () => {
  it("renders a clean workspace", () => {
    const result: WorkspaceDiagnostics = { servers: [], files: [], counts: { error: 0, warning: 0, information: 0, hint: 0, total: 0 } };
    const output = renderDiagnostics(result, context);
    expect(output).toContain("No diagnostics");
  });

  it("renders errors and warnings with correct formatting", () => {
    const result: WorkspaceDiagnostics = {
      servers: [],
      files: [{
        path: "src/app.ts",
        diagnostics: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "Cannot find name 'foo'.", source: "typescript", code: 2304 },
        ],
      }],
      counts: { error: 1, warning: 0, information: 0, hint: 0, total: 1 },
    };
    const output = renderDiagnostics(result, context);
    expect(output).toContain("1 error");
    expect(output).toContain("src/app.ts");
    expect(output).toContain("ERROR");
    expect(output).toContain("1:1");
    expect(output).toContain("Cannot find name 'foo'.");
    expect(output).toContain("[typescript]");
    expect(output).toContain("(2304)");
  });

  it("renders unavailable servers", () => {
    const result: WorkspaceDiagnostics = {
      servers: [
        { server: { id: "go", command: "gopls", args: [], extensions: [], languageIds: [] }, ok: false, error: "gopls is not installed", files: [] },
      ],
      files: [],
      counts: { error: 0, warning: 0, information: 0, hint: 0, total: 0 },
    };
    const output = renderDiagnostics(result, context);
    expect(output).toContain("gopls is not installed");
  });
});
