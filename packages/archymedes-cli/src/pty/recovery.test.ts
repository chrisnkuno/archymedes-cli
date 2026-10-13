import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
 * is usable. Each turn is a one-shot run of the agent against the local SSE stub over a real socket.
 */

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
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    stub.enqueue({ kind: "disconnect", text: "the first half of a sentence" });
    stub.enqueue({ kind: "text", text: "the whole answer, delivered on the retry" });

    const p = boot({ args: ["answer the question"] });
    await p.waitFor(/the whole answer, delivered on the retry/, { timeoutMs: 30_000 });
    expect((await p.waitForExit(20_000)).exitCode).toBe(0);

    const screen = plain(p.output());
    // The drop is surfaced as a bounded retry, not a crash and not a silent stall.
    expect(screen).toMatch(/connection failed; retrying model request \d\/\d/);
    // Two requests reached the stub: the dropped one and its retry.
    expect(stub.requestCount()).toBe(2);
    // The abandoned partial is not stitched in front of the retry's answer.
    expect((screen.match(/the first half of a sentence/g) ?? []).length).toBeLessThanOrEqual(1);

  }, 90_000);

  it("keeps a tool's effect exactly once when the process is killed before the turn ends", async () => {
    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "out.txt", content: "written once\n" } });
    // The model's closing message is deliberately never queued: the turn is still in flight when
    // the signal lands.
    const first = boot({ args: ["write out.txt"] });
    await first.waitFor(/new file|out\.txt/, { timeoutMs: 30_000 });

    // Wait until the write has actually reached disk, then kill hard with the turn still open
    // (no closing model message was ever queued).
    const target = path.join(cwd, "out.txt");
    const landed = performance.now();
    while (performance.now() - landed < 15_000) {
      if (await stat(target).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // And until the mid-turn save that follows it has landed: the guarantee under test is that a
    // saved tool step survives the kill, not a race against the few milliseconds before the save.
    const sessions = path.join(cwd, ".archymedes", "sessions");
    const saving = performance.now();
    const savedStep = async () => {
      for (const name of await readdir(sessions).catch(() => [] as string[])) {
        if (name.endsWith(".json") && (await readFile(path.join(sessions, name), "utf8").catch(() => "")).includes("Wrote out.txt")) return true;
      }
      return false;
    };
    while (performance.now() - saving < 15_000 && !(await savedStep())) await new Promise((resolve) => setTimeout(resolve, 50));
    first.kill("SIGKILL");
    await first.waitForExit(8_000).catch(() => undefined);

    // The invariant that always holds: the write that had already happened is on disk, exactly
    // once — no partial file, no duplicate from a half-applied edit.
    expect(await readFile(target, "utf8")).toBe("written once\n");

    // The turn is saved after each tool step, so `--resume` finds this interrupted turn — request,
    // tool call and result — rather than depending on when the signal landed. A resumed run does
    // not re-apply the write, and takes a new turn with that history.
    stub.enqueue({ kind: "text", text: "recovered and responsive" });
    const afterKill = boot({ args: ["--resume", "latest", "are you there?"] });
    await afterKill.waitFor(/recovered and responsive/, { timeoutMs: 30_000 });
    expect(await readFile(target, "utf8")).toBe("written once\n");
    const history = JSON.stringify(stub.requests().at(-1)?.messages ?? []);
    // The interrupted request and its tool work are in the resumed conversation. (Whether the note
    // closing it appears depends on whether the model's next step had also finished before the kill.)
    expect(history).toContain("write out.txt");
    expect(history).toContain("Wrote out.txt");
  }, 120_000);
});
