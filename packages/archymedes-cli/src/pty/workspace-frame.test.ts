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
    // No --layout: the fixed workspace is the default for an interactive terminal.
    const proc = spawnArchymedes({ cwd: root, args: ["--currency", "USD"], cols: 100, rows: 30,
      env: { ANTHROPIC_API_KEY: "sk-test-fake", ANTHROPIC_BASE_URL: stub.url, ARCHYMEDES_CONFIG_DIR: path.join(root, "config"), ARCHYMEDES_FX_OFFLINE: "true", ARCHYMEDES_NO_MOTION: "1", PAGER: "cat", TZ: "UTC" } });
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
      // A wheel notch scrolls the transcript and never reaches the composer as typed text.
      expect(proc.output()).toContain("\x1b[?1000h\x1b[?1006h");
      const beforeWheel = proc.output().length;
      proc.write("\x1b[<64;20;10M");
      await proc.waitFor(/HISTORY \d+%/, { since: beforeWheel });
      const beforeLine = proc.output().length;
      proc.write("\x1b[1;3A");
      await proc.waitFor(/HISTORY \d+%/, { since: beforeLine });
      const beforeEnd = proc.output().length;
      proc.write("\x1b[1;5F");
      await proc.waitFor("LIVE", { since: beforeEnd });
      expect(proc.output().slice(beforeWheel)).not.toContain("<64;20;10M");
      // Search holds history across /find steps, and /find off returns to live output.
      const beforeFind = proc.output().length;
      proc.writeLine("/find result 1");
      await proc.waitFor(/FIND 1\/11 "result 1"/, { since: beforeFind });
      const beforeNext = proc.output().length;
      proc.writeLine("/find");
      await proc.waitFor(/FIND 2\/11/, { since: beforeNext });
      const beforeOff = proc.output().length;
      proc.writeLine("/find off");
      await proc.waitFor("LIVE", { since: beforeOff });
      // The pager gets the whole transcript and hands the terminal back.
      const beforePager = proc.output().length;
      proc.writeLine("/pager");
      const handedOver = await proc.waitFor("\x1b[?1049l", { since: beforePager });
      await proc.waitFor("workspace result 0", { since: handedOver.indexOf("\x1b[?1049l", beforePager) });
      await proc.waitFor("\x1b[?1049h", { since: beforePager });
      const beforeMode = proc.output().length;
      proc.writeLine("/mode");
      await proc.waitFor("Choose how Archymedes works", { since: beforeMode });
      proc.write("\x1b[A\r");
      await proc.waitFor("switched to plan mode");
      // Resize an open menu, cancel it, and confirm readline still accepts commands.
      const beforeReopen = proc.output().length;
      proc.writeLine("/mode");
      await proc.waitFor("Choose how Archymedes works", { since: beforeReopen });
      const beforeResize = proc.output().length;
      proc.resize(40, 12);
      await proc.waitFor("MENU", { since: beforeResize });
      const beforeDismiss = proc.output().length;
      proc.write("\x1b");
      await proc.waitFor("LIVE", { since: beforeDismiss });
      const beforeHelp = proc.output().length;
      proc.writeLine("/where");
      await proc.waitFor(root, { since: beforeHelp });
      proc.resize(120, 35);
      const beforeToggle = proc.output().length;
      proc.writeLine("/layout scrollback");
      await proc.waitFor("\x1b[?1049l", { since: beforeToggle });
      expect(proc.output().slice(beforeToggle)).toContain("\x1b[?1006l\x1b[?1000l");
      proc.writeLine("/exit");
      expect((await proc.waitForExit()).exitCode).toBe(0);
      expect(stub.requestCount()).toBe(1);
    } finally {
      proc.kill(); await stub.close(); await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
