import type { PlacedSecretFinding } from "@archymedes/core/cli/tools";
import { barChart } from "../render/charts";
import type { GlyphSet } from "../text/glyphs";
import type { ColorDepth } from "../text/color-depth";
import { displayMask, fixObjective, type DefenderOutcome } from "../ui/defender-screen";

type Paint = (text: string) => string;

export type ScanContext = {
  scanSecrets(include?: string): Promise<PlacedSecretFinding[]>;
  /** A window of a file through the workspace, or null when it cannot be read. */
  readWindow(path: string, offset: number, limit: number): Promise<{ content: string; startLine: number } | null>;
  /** The interactive triage queue; omitted when nobody is at the keyboard. */
  triage?: (findings: readonly PlacedSecretFinding[], loadEvidence: (finding: PlacedSecretFinding) => Promise<readonly string[] | undefined>) => Promise<DefenderOutcome>;
  /** Puts turns at the front of the input queue, in the order given. */
  queueFirst(objectives: string[]): void;
  write(text: string): void;
  paint: { dim: Paint; green: Paint; yellow: Paint; red: Paint };
  glyphs: GlyphSet;
  depth: ColorDepth;
  width: number;
};

/**
 * `/scan [glob]`: the deterministic secret scan, worst severity first. Interactive sessions get the
 * triage queue, one finding at a time with its evidence and a decision; otherwise the findings print
 * as lines. Returns how many findings remain open, for the status line.
 */
export async function runScan(include: string | undefined, context: ScanContext): Promise<number> {
  const { paint, glyphs, write } = context;
  write(paint.dim("  scanning for likely hardcoded secrets…\n"));
  const findings = await context.scanSecrets(include);
  const plural = `${findings.length} possible secret${findings.length === 1 ? "" : "s"}`;
  if (findings.length === 0) {
    write(`  ${paint.green(glyphs.check)} No likely secrets found by pattern${include ? ` in ${include}` : ""}.\n`);
    return 0;
  }

  if (context.triage) {
    write(`  ${paint.yellow(plural)} found by pattern${include ? ` in ${include}` : ""} — verify each; a pattern match is a lead, not proof.\n`);
    const outcome = await context.triage(findings, async (finding) => {
      const window = await context.readWindow(finding.path, Math.max(1, finding.line - 2), 5);
      if (!window) return undefined;
      // Never the file's own text for the matched line: the secret sits on it, and masking exists so it is not printed.
      return window.content.split("\n").map((line, index) => {
        const number = window.startLine + index;
        return number === finding.line ? `${number} | ${finding.masked}  (${finding.kind})` : `${number} | ${line}`;
      });
    });
    for (const finding of outcome.toFix) {
      write(`  ${paint.yellow(glyphs.pending)} queued for repair: ${finding.path}:${finding.line} ${paint.dim(finding.kind)}\n`);
    }
    // Decisions become work, one turn each, in the order they were picked; a model turn needs the terminal back first.
    context.queueFirst(outcome.toFix.map(fixObjective));
    const ignored = outcome.findings.filter((finding) => finding.triage === "ignored").length;
    if (ignored > 0) write(paint.dim(`  ${ignored} ignored this pass\n`));
    return outcome.findings.filter((finding) => finding.triage === "open").length;
  }

  const bySeverity = new Map<string, number>();
  for (const finding of findings) bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  write(`  ${paint.yellow(plural)} found by pattern, worst first — verify each; a pattern match is a lead, not proof.\n`);
  // Bar length is the count and the label is the severity: shading by count once drew fourteen
  // mediums darker than two criticals, which a security summary must never imply.
  for (const line of barChart(
    (["critical", "high", "medium"] as const)
      .filter((severity) => bySeverity.has(severity))
      .map((severity) => ({ label: severity, value: bySeverity.get(severity) ?? 0 })),
    { width: Math.min(60, context.width), depth: context.depth, glyphs, max: findings.length },
  )) write(`  ${line}\n`);
  write("\n");
  for (const finding of findings) {
    const severity = finding.severity === "critical" ? paint.red : finding.severity === "high" ? paint.yellow : paint.dim;
    write(`  ${severity(`[${finding.severity}]`)} ${finding.path}:${finding.line}: ${finding.kind} — ${paint.dim(displayMask(finding.masked, glyphs))}\n`);
  }
  return findings.length;
}
