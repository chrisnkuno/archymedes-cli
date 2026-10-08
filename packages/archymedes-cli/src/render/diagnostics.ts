import type { WorkspaceDiagnostics } from "@archymedes/core/lsp/collect";
import { severityName } from "@archymedes/core/lsp/diagnostics";
import type { LspDiagnostic } from "@archymedes/core/lsp/protocol";
import type { GlyphSet } from "../text/glyphs";
import type { ColorDepth } from "../text/color-depth";

type Paint = (text: string) => string;

export function renderDiagnostics(
  result: WorkspaceDiagnostics,
  context: { paint: { dim: Paint; green: Paint; yellow: Paint; red: Paint; cyan: Paint }; glyphs: GlyphSet; depth: ColorDepth; width: number },
): string {
  const { paint, glyphs } = context;
  const lines: string[] = [];
  const { counts, files, servers } = result;

  if (counts.total === 0) {
    lines.push(`  ${paint.green(glyphs.check)} No diagnostics from language servers.`);
    const unavailable = servers.filter((s) => !s.ok);
    if (unavailable.length > 0) {
      lines.push(paint.dim(`  ${unavailable.length} server${unavailable.length === 1 ? "" : "s"} not available: ${unavailable.map((s) => `${s.server.command}${s.error ? ` (${s.error})` : ""}`).join(", ")}`));
    }
    return `${lines.join("\n")}\n`;
  }

  const summary = `  ${paint.red(String(counts.error))} error${counts.error === 1 ? "" : "s"}, ${paint.yellow(String(counts.warning))} warning${counts.warning === 1 ? "" : "s"}, ${paint.dim(String(counts.information))} info, ${paint.dim(String(counts.hint))} hint`;
  lines.push(summary);
  lines.push("");

  for (const file of files) {
    const relative = file.path;
    lines.push(`  ${paint.cyan(relative)}`);
    for (const diagnostic of file.diagnostics) {
      lines.push(renderDiagnosticLine(diagnostic, context));
    }
    lines.push("");
  }

  const unavailable = servers.filter((s) => !s.ok);
  if (unavailable.length > 0) {
    lines.push(paint.dim(`  Servers not available: ${unavailable.map((s) => `${s.server.command} (${s.error ?? "unknown"})`).join(", ")}`));
  }

  return `${lines.join("\n")}\n`;
}

function renderDiagnosticLine(
  diagnostic: LspDiagnostic,
  context: { paint: { dim: Paint; green: Paint; yellow: Paint; red: Paint; cyan: Paint }; glyphs: GlyphSet; depth: ColorDepth; width: number },
): string {
  const { paint } = context;
  const severity = severityName(diagnostic.severity);
  const severityPaint = severity === "error" ? paint.red : severity === "warning" ? paint.yellow : paint.dim;
  const location = `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
  const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
  const code = diagnostic.code !== undefined ? ` (${diagnostic.code})` : "";
  return `    ${severityPaint(severity.toUpperCase())} ${location}${source}${code} ${diagnostic.message}`;
}
