import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installInChildProcess, startupMaintenance } from "./startup-update";

describe("startup upkeep for a client that draws its own screen", () => {
  it("installs through a separate process and reports its exit, writing nothing of its own", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "update-child-"));
    const ok = path.join(dir, "ok.mjs");
    const fail = path.join(dir, "fail.mjs");
    await writeFile(ok, 'process.stdout.write("npm noise that must not reach the protocol\\n"); process.exit(process.argv.includes("--yes") && process.argv.includes("update") ? 0 : 3);');
    await writeFile(fail, "process.exit(1);");
    expect(await installInChildProcess({ execPath: process.execPath, script: ok }, {})("3.0.1")).toBe(true);
    expect(await installInChildProcess({ execPath: process.execPath, script: fail }, {})("3.0.1")).toBe(false);
    expect(await installInChildProcess({ execPath: "/nonexistent/node", script: ok }, {})("3.0.1")).toBe(false);
  });

  it("does nothing, and says nothing, when automatic updates are off", async () => {
    let installs = 0;
    const notices = await startupMaintenance({ ARCHYMEDES_AUTO_UPDATE: "off", ARCHYMEDES_DEFENDER_FEED_URL: "http://127.0.0.1:9/off" }, false, async () => { installs += 1; return true; });
    expect(notices).toEqual([]);
    expect(installs).toBe(0);
  });
});
