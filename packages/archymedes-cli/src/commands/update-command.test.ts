import { describe, expect, it } from "vitest";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { parseUpdatePolicy, runUpdateCommand, type UpdateCommandContext } from "./update-command";

function context(overrides: Partial<UpdateCommandContext> = {}) {
  const written: string[] = [];
  const ran: string[] = [];
  const same = (text: string) => text;
  const ctx: UpdateCommandContext = {
    currentVersion: "2.2.0",
    fetchLatest: async () => "2.3.0",
    compareVersions: (a, b) => a.localeCompare(b),
    savePolicy: async () => true,
    confirm: async () => true,
    runUpdate: async () => { ran.push("update"); return { status: "updated", latestVersion: "2.3.0" }; },
    write: (text) => written.push(text),
    paint: { dim: same, yellow: same, green: same, bold: same },
    glyphs: UNICODE_GLYPHS,
    ...overrides,
  };
  return { ctx, written, ran };
}

describe("/update", () => {
  it("parses policies and refuses anything else", async () => {
    expect([parseUpdatePolicy("on"), parseUpdatePolicy("notify"), parseUpdatePolicy("never"), parseUpdatePolicy("weekly")]).toEqual(["install", "check", "off", undefined]);
    const { ctx, written } = context({ savePolicy: async () => false });
    await runUpdateCommand("check", ctx);
    expect(written[0]).toContain("check daily and tell you.");
    expect(written[0]).toContain("not saved");
  });

  it("installs only after consent, and never downgrades", async () => {
    const yes = context();
    await runUpdateCommand("", yes.ctx);
    expect(yes.ran).toEqual(["update"]);
    expect(yes.written.at(-1)).toContain("Updated to 2.3.0");
    const no = context({ confirm: async () => false });
    await runUpdateCommand("", no.ctx);
    expect(no.ran).toEqual([]);
    const newer = context({ fetchLatest: async () => "2.1.0" });
    await runUpdateCommand("", newer.ctx);
    expect(newer.written.at(-1)).toContain("no downgrade offered");
    const offline = context({ fetchLatest: async () => undefined });
    await runUpdateCommand("", offline.ctx);
    expect(offline.written.at(-1)).toContain("Could not reach the registry");
  });
});
