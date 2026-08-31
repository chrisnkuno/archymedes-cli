import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnArchymedes, type ArchymedesProcess } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * The `/balance` command, in a real terminal.
 *
 * The unit tests prove the grammar and the wording. This proves the thing they cannot: that
 * `/balance` is reachable from the prompt at all, that a figure set there is persisted, and that
 * `/balance clear` stops tracking.
 */

const PROMPT = /›|auto >/;

describe("tracking a balance from the prompt", () => {
  let model: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: ArchymedesProcess | undefined;

  beforeEach(async () => {
    model = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-pty-balance-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-pty-balance-config-"));
  });

  afterEach(async () => {
    proc?.kill();
    proc = undefined;
    await model.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  function boot(env: Record<string, string> = {}): ArchymedesProcess {
    proc = spawnArchymedes({
      cwd,
      cols: 110,
      args: ["--currency", "USD"],
      env: {
        ANTHROPIC_API_KEY: "sk-test-fake",
        ANTHROPIC_BASE_URL: model.url,
        ARCHYMEDES_CONFIG_DIR: configDir,
        ARCHYMEDES_FX_OFFLINE: "true",
        TZ: "UTC",
        ...env,
      },
    });
    return proc;
  }

  it("sets and persists a balance, then shows it on a bare /balance", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    let since = p.output().length;
    p.writeLine("/balance 5000");
    await p.waitFor(/Balance set to/, { since, timeoutMs: 30_000 });

    const settingsPath = path.join(configDir, "settings.json");
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(saved.ARCHYMEDES_ACCOUNT_BALANCE).toBe("5000");

    since = p.output().length;
    p.writeLine("/balance");
    await p.waitFor(/Balance .*5,000/, { since, timeoutMs: 30_000 });
  });

  it("takes an explicit currency and clears on request", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    let since = p.output().length;
    p.writeLine("/balance 400 eur");
    await p.waitFor(/Balance set to/, { since, timeoutMs: 30_000 });
    const saved = JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8"));
    expect(saved.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY).toBe("EUR");

    since = p.output().length;
    p.writeLine("/balance clear");
    await p.waitFor(/tracking cleared/, { since, timeoutMs: 30_000 });
    since = p.output().length;
    p.writeLine("/balance");
    await p.waitFor(/No balance is being tracked/, { since, timeoutMs: 30_000 });
  });
});
