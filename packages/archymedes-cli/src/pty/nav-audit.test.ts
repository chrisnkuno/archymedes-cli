/**
 * Runs the navigation audit on demand (`bun run audit:nav`), not in the ordinary suite: it drives
 * every menu in a real pty and, with TYPESAFE_API_KEY set, asks Jev about every step. The report
 * and the raw records (screens included) are written for a human to read; the deterministic
 * regressions it finds become ordinary tests elsewhere.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFinding, navReport, runNavAudit } from "./nav-audit";

const enabled = process.env.ARCHYMEDES_NAV_AUDIT === "1";
const outDir = path.resolve(__dirname, "../../../../benchmarks/nav-audit");

describe.skipIf(!enabled)("navigation audit", () => {
  it("drives every menu and records each step", { timeout: 900_000 }, async () => {
    const only = process.env.ARCHYMEDES_NAV_AUDIT_ONLY?.split(",").map((name) => name.trim()).filter(Boolean);
    const records = await runNavAudit({
      ...(process.env.TYPESAFE_API_KEY?.trim() ? { apiKey: process.env.TYPESAFE_API_KEY.trim() } : {}),
      ...(process.env.TYPESAFE_MODEL ? { model: process.env.TYPESAFE_MODEL } : {}),
      ...(only?.length ? { only } : {}),
    });
    await mkdir(outDir, { recursive: true });
    const report = navReport(records);
    await writeFile(path.join(outDir, "latest.md"), `${report}\n`);
    await writeFile(path.join(outDir, "latest.json"), `${JSON.stringify(records, null, 2)}\n`);
    console.log(report);
    console.log(`${records.filter(isFinding).length} of ${records.length} steps flagged`);
    expect(records.length).toBeGreaterThan(0);
  });
});
