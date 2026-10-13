import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnArchymedes, type ArchymedesProcess } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * What a resumed one-shot run prints, on a real tty.
 *
 * `src/resume.test.ts` proves the mechanics — the right record is found, the transcript reaches
 * the model, the same file keeps being written. The Go interface's own resume is covered in
 * `go-frontend.test.ts`; this is the agent's one-shot `--resume`.
 */

describe("resuming, from the terminal", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: ArchymedesProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-pty-resume-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-pty-resume-config-"));
  });

  afterEach(async () => {
    proc?.kill();
    proc = undefined;
    await stub.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function boot(args: string[] = [], extra: Record<string, string> = {}): ArchymedesProcess {
    proc = spawnArchymedes({
      cwd,
      args: ["--currency", "USD", ...args],
      cols: 120,
      env: {
        ANTHROPIC_API_KEY: "sk-test-fake",
        ANTHROPIC_BASE_URL: stub.url,
        ARCHYMEDES_CONFIG_DIR: configDir,
        ARCHYMEDES_FX_OFFLINE: "true",
        TZ: "UTC",
        ...extra,
      },
    });
    return proc;
  }

  it("keeps the past conversation out of the way of a one-shot run", async () => {
    // A replay is orientation for someone about to type. `archymedes --resume "…"` is not that: the
    // answer is the output, and the transcript in front of it is noise a script has to skip.
    stub.enqueue({ kind: "text", text: "The migration lives in db/0007-add-index.sql." });
    const first = boot(["where does the migration live?"]);
    await first.waitFor(/0007-add-index/, { timeoutMs: 60_000 });
    await first.waitForExit(30_000);

    stub.enqueue({ kind: "text", text: "Still db/0007-add-index.sql." });
    const oneShot = boot(["--resume", "and now?"]);
    await oneShot.waitFor(/Still db/, { timeoutMs: 60_000 });
    await oneShot.waitForExit(30_000);

    // The id line still names the session — that is the confirmation, and it carries the title,
    // which is the opening request. What must not appear is the replay itself: the earlier answer
    // and the transcript chrome around it.
    expect(oneShot.output()).toMatch(/Resumed \d{8}T\d{6}Z-/);
    expect(oneShot.output()).not.toContain("The migration lives in");
    expect(oneShot.output()).not.toContain("end of session");
  }, 120_000);
});
