import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnArchymedes, type ArchymedesProcess, type SpawnArchymedesOptions } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * What survives a failure that is not a clean exit.
 *
 * The unit and stream tests cover the happy path and the well-formed error (a 429, a 401). This
 * file is the other kind: the connection drops with bytes still owed, the process is killed with a
 * signal it cannot catch, a turn ends halfway through its tool calls. The measure is not what the
 * model finally said — it is whether an effect happened exactly once and whether the next session
 * is usable. Everything runs against the local SSE stub over a real socket.
 */

const PROMPT = /›|auto >/;
const plain = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

describe("recovery from an unclean failure", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let procs: ArchymedesProcess[] = [];

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-recovery-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-recovery-config-"));
    spawnSync("git", ["init", "-q"], { cwd });
    spawnSync("git", ["config", "user.email", "bench@example.com"], { cwd });
    spawnSync("git", ["config", "user.name", "bench"], { cwd });
    spawnSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd });
  });

  afterEach(async () => {
    for (const proc of procs) proc.kill();
    procs = [];
    await stub.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  function boot(options: Partial<SpawnArchymedesOptions> = {}): ArchymedesProcess {
    const proc = spawnArchymedes({
      cwd,
      cols: 100,
      rows: 34,
      args: ["--currency", "USD", "--auto", ...(options.args ?? [])],
      env: {
        ANTHROPIC_API_KEY: "sk-test-fake",
        ANTHROPIC_BASE_URL: stub.url,
        ARCHYMEDES_CONFIG_DIR: configDir,
        ARCHYMEDES_FX_OFFLINE: "true",
        TZ: "UTC",
        ...options.env,
      },
    });
    procs.push(proc);
    return proc;
  }

  it("retries within the turn when the model connection drops mid-stream, without doubling the partial answer", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    stub.enqueue({ kind: "disconnect", text: "the first half of a sentence" });
    stub.enqueue({ kind: "text", text: "the whole answer, delivered on the retry" });

    const mark = p.output().length;
    p.writeLine("answer the question");
    await p.waitFor(/the whole answer, delivered on the retry/, { timeoutMs: 30_000, since: mark });
    await p.waitFor(PROMPT, { timeoutMs: 15_000, since: mark });

    const screen = plain(p.output());
    // The drop is surfaced as a bounded retry, not a crash and not a silent stall.
    expect(screen).toMatch(/connection failed; retrying model request \d\/\d/);
    // Two requests reached the stub: the dropped one and its retry.
    expect(stub.requestCount()).toBe(2);
    // The abandoned partial is not stitched in front of the retry's answer.
    expect((screen.match(/the first half of a sentence/g) ?? []).length).toBeLessThanOrEqual(1);

    // Usable afterwards: a fresh turn completes.
    stub.enqueue({ kind: "text", text: "and a later turn still works" });
    const after = p.output().length;
    p.writeLine("one more");
    await p.waitFor(/and a later turn still works/, { timeoutMs: 30_000, since: after });
  }, 90_000);

  it("keeps a tool's effect exactly once when the process is killed before the turn ends", async () => {
    const first = boot();
    await first.waitFor(PROMPT, { timeoutMs: 30_000 });

    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "out.txt", content: "written once\n" } });
    // The model's closing message is deliberately never queued: the turn is still in flight when
    // the signal lands.
    const mark = first.output().length;
    first.writeLine("write out.txt");
    await first.waitFor(/new file|out\.txt/, { timeoutMs: 30_000, since: mark });

    // Wait until the write has actually reached disk, then kill hard with the turn still open
    // (no closing model message was ever queued).
    const target = path.join(cwd, "out.txt");
    const landed = performance.now();
    while (performance.now() - landed < 15_000) {
      if (await stat(target).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    first.kill("SIGKILL");
    await first.waitForExit(8_000).catch(() => undefined);

    // The invariant that always holds: the write that had already happened is on disk, exactly
    // once — no partial file, no duplicate from a half-applied edit.
    expect(await readFile(target, "utf8")).toBe("written once\n");

    // Whether `--resume` then finds a session is timing-dependent — session records are
    // turn-atomic, so it depends on whether the turn had been checkpointed at the instant the
    // signal landed (see RELEASE_ASSESSMENT item 5). Either way the CLI comes back to a usable
    // prompt, does not re-apply the write, and takes a new turn.
    const afterKill = boot({ args: ["--resume"] });
    await afterKill.waitFor(PROMPT, { timeoutMs: 30_000 });
    expect(await readFile(target, "utf8")).toBe("written once\n");
    stub.enqueue({ kind: "text", text: "recovered and responsive" });
    const mark2 = afterKill.output().length;
    afterKill.writeLine("are you there?");
    await afterKill.waitFor(/recovered and responsive/, { timeoutMs: 30_000, since: mark2 });
  }, 120_000);

  it("does not hang when interrupted twice in quick succession mid-turn", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    stub.enqueue({ kind: "text", text: "slow ".repeat(300), chunkSize: 8, chunkDelayMs: 200 });
    const mark = p.output().length;
    p.writeLine("stream slowly");
    await p.waitFor(/slow slow/, { timeoutMs: 15_000, since: mark });

    const interruptedAt = Date.now();
    p.write("\x03");
    p.write("\x03");
    await p.waitFor(/interrupted/i, { timeoutMs: 8_000, since: mark });
    await p.waitFor(PROMPT, { timeoutMs: 15_000, since: p.output().length });
    expect(Date.now() - interruptedAt).toBeLessThan(4_000);

    // Still a working prompt, not a wedged one under a readline artifact.
    const afterPrompt = p.output().length;
    p.writeLine("/help");
    await p.waitFor(/Find your way around|\/palette/i, { timeoutMs: 10_000, since: afterPrompt });
  }, 90_000);
});
