import type { PlacedSecretFinding } from "@archymedes/core/cli/tools";
import { describe, expect, it } from "vitest";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { runScan, type ScanContext } from "./scan";

const finding = (path: string, severity: PlacedSecretFinding["severity"], line = 3): PlacedSecretFinding =>
  ({ path, line, kind: "AWS access key", masked: "AKIA…7Q2P", severity });

function context(findings: PlacedSecretFinding[], overrides: Partial<ScanContext> = {}) {
  const written: string[] = [];
  const queued: string[] = [];
  const same = (text: string) => text;
  const ctx: ScanContext = {
    scanSecrets: async () => findings,
    readWindow: async () => ({ content: "a\nb\nsecret line\nd\ne", startLine: 1 }),
    queueFirst: (objectives) => queued.unshift(...objectives),
    write: (text) => written.push(text),
    paint: { dim: same, green: same, yellow: same, red: same },
    glyphs: UNICODE_GLYPHS,
    depth: "none",
    width: 80,
    ...overrides,
  };
  return { ctx, written, queued };
}

describe("/scan", () => {
  it("says plainly when nothing matched", async () => {
    const { ctx, written } = context([]);
    expect(await runScan("src/**", ctx)).toBe(0);
    expect(written.join("")).toContain("No likely secrets found by pattern in src/**.");
  });

  it("lists findings worst first without a keyboard, never printing the unmasked secret", async () => {
    const { ctx, written } = context([finding("a.ts", "critical"), finding("b.ts", "medium")]);
    expect(await runScan(undefined, ctx)).toBe(2);
    const text = written.join("");
    expect(text).toContain("2 possible secrets found by pattern, worst first");
    expect(text).toContain("[critical] a.ts:3: AWS access key");
    expect(text).toContain("AKIA");
  });

  it("triages interactively, masks the matched line in evidence, and queues repairs in picked order", async () => {
    const found = [finding("a.ts", "critical"), finding("b.ts", "high")];
    let evidence: readonly string[] | undefined;
    const { ctx, written, queued } = context(found, {
      triage: async (findings, loadEvidence) => {
        evidence = await loadEvidence(findings[0]);
        return {
          toFix: [{ ...found[1], triage: "fixing" }, { ...found[0], triage: "fixing" }],
          findings: [{ ...found[0], triage: "fixing" }, { ...found[1], triage: "fixing" }, { ...finding("c.ts", "medium"), triage: "ignored" }],
        };
      },
    });
    expect(await runScan(undefined, ctx)).toBe(0);
    expect(evidence?.[2]).toBe("3 | AKIA…7Q2P  (AWS access key)");
    expect(evidence?.join("\n")).not.toContain("secret line");
    expect(queued).toHaveLength(2);
    expect(queued[0]).toContain("b.ts");
    expect(written.join("")).toContain("1 ignored this pass");
  });
});
