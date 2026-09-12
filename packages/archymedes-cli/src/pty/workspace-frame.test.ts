import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spawnArchymedes } from "./harness";
import { startAnthropicStub } from "./anthropic-stub";

describe("the real CLI in a fixed workspace", () => {
  it("runs a turn, reads history, selects a permission mode, resizes and returns the terminal", async () => {
    const stub = await startAnthropicStub();
    const root = await mkdtemp(path.join(os.tmpdir(), "archymedes-fixed-"));
    const proc = spawnArchymedes({ cwd: root, args: ["--layout", "fixed", "--currency", "USD"], cols: 100, rows: 30,
      env: { ANTHROPIC_API_KEY: "sk-test-fake", ANTHROPIC_BASE_URL: stub.url, ARCHYMEDES_CONFIG_DIR: path.join(root, "config"), ARCHYMEDES_FX_OFFLINE: "true", ARCHYMEDES_NO_MOTION: "1", TZ: "UTC" } });
    try {
      await proc.waitFor("\x1b[?1049h");
      await proc.waitFor(/›/);
      stub.enqueue({ kind: "text", text: Array.from({ length: 45 }, (_, i) => `workspace result ${i}`).join("\n") });
      proc.writeLine("describe the workspace");
      await proc.waitFor("workspace result 44");
      await proc.waitFor(/turn complete|completed|complete/i);
      const beforeHistory = proc.output().length;
      proc.write("\x1b[5~");
      await proc.waitFor("HISTORY", { since: beforeHistory });
      const beforeLive = proc.output().length;
      proc.write("\x1b");
      await proc.waitFor("LIVE", { since: beforeLive });
      const beforeMode = proc.output().length;
      proc.writeLine("/mode");
      await proc.waitFor("Choose how Archymedes works", { since: beforeMode });
      proc.write("\x1b[A\r");
      await proc.waitFor("switched to plan mode");
      proc.resize(40, 12);
      const beforeHelp = proc.output().length;
      proc.writeLine("/where");
      await proc.waitFor(root, { since: beforeHelp });
      proc.resize(120, 35);
      const beforeToggle = proc.output().length;
      proc.writeLine("/layout scrollback");
      await proc.waitFor("\x1b[?1049l", { since: beforeToggle });
      proc.writeLine("/exit");
      expect((await proc.waitForExit()).exitCode).toBe(0);
      expect(stub.requestCount()).toBe(1);
    } finally {
      proc.kill(); await stub.close(); await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
