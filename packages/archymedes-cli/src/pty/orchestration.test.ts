import { saveSession, newSessionId } from "@archymedes/core/cli/session";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnArchymedes, type ArchymedesProcess, type SpawnArchymedesOptions } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * The safety net under the REPL-loop extraction.
 *
 * `archymedes.ts` is being taken apart one handler at a time. The property that makes a handler
 * safe to lift out first is that it is read-only — it does not call the model, move the cost
 * ledger, write a checkpoint or change the mode. This pins that property for the commands already
 * extracted into `session-inspect.ts` (`/task`, `/todos`), so a later refactor that quietly gives
 * one of them a side effect fails here.
 */

const PROMPT = /›|auto >/;
const plain = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

describe("read-only inspection commands do not disturb the session", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: ArchymedesProcess | undefined;

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-orch-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-orch-config-"));
    spawnSync("git", ["init", "-q"], { cwd });
    spawnSync("git", ["config", "user.email", "bench@example.com"], { cwd });
    spawnSync("git", ["config", "user.name", "bench"], { cwd });
    spawnSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd });
  });

  afterEach(async () => {
    proc?.kill();
    proc = undefined;
    await stub.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  function boot(options: Partial<SpawnArchymedesOptions> = {}): ArchymedesProcess {
    proc = spawnArchymedes({
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
    return proc;
  }

  it("/task and /todos call no model, change no file, and leave the session able to take the next turn", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "slug.ts", content: "export const slug = (s: string) => s;\n" } });
    stub.enqueue({ kind: "text", text: "Added the slug helper." });
    let mark = p.output().length;
    p.writeLine("add a slug helper");
    await p.waitFor(/turn complete|needs attention|verification (needed|not run)/, { timeoutMs: 30_000, since: mark });
    await p.waitFor(PROMPT, { timeoutMs: 20_000, since: mark });

    const requestsAfterTurn = stub.requestCount();
    const fileAfterTurn = await readFile(path.join(cwd, "slug.ts"), "utf8");

    // The task-view body, without the input echo or the prompt frame the pty redraws around it.
    const taskBody = (slice: string) => plain(slice)
      .split(/\r?\n/)
      .filter((line) => /^\s{2}(task|request|plan|changed|verified|blockers|done|wip|todo|src\/|\d+ files|! |─)/.test(line) || /^\s{4}/.test(line))
      .join("\n");

    // Run the inspection commands several times.
    let firstTaskView = "";
    for (let round = 0; round < 3; round += 1) {
      mark = p.output().length;
      p.writeLine("/task");
      await p.waitFor(/changed .* \/diff/, { timeoutMs: 15_000, since: mark });
      await p.waitFor(PROMPT, { timeoutMs: 10_000, since: mark });
      if (round === 0) firstTaskView = taskBody(p.output().slice(mark));

      mark = p.output().length;
      p.writeLine("/todos");
      await p.waitFor(PROMPT, { timeoutMs: 10_000, since: mark });
    }

    // No model call, no file change.
    expect(stub.requestCount(), "inspection commands must not call the model").toBe(requestsAfterTurn);
    expect(await readFile(path.join(cwd, "slug.ts"), "utf8"), "inspection commands must not write").toBe(fileAfterTurn);

    // Idempotent: the same snapshot renders the same body.
    mark = p.output().length;
    p.writeLine("/task");
    await p.waitFor(/changed .* \/diff/, { timeoutMs: 15_000, since: mark });
    await p.waitFor(PROMPT, { timeoutMs: 10_000, since: mark });
    expect(taskBody(p.output().slice(mark))).toBe(firstTaskView);
    expect(firstTaskView).toContain("changed");

    // The session is not wedged: the next real turn still runs.
    stub.enqueue({ kind: "text", text: "still working" });
    mark = p.output().length;
    p.writeLine("anything else?");
    await p.waitFor(/still working/, { timeoutMs: 30_000, since: mark });
    expect(stub.requestCount()).toBe(requestsAfterTurn + 1);
  }, 120_000);

  it("/route plan says a direct provider has one route, and spends nothing asking", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    const requestsAfterTurn = stub.requestCount();

    // A preflight has nothing to weigh without the exchange, and it must say that rather than
    // quietly ranking the one provider the session already has.
    let mark = p.output().length;
    p.writeLine("/route plan");
    await p.waitFor(/needs the archymedes-cloud provider/, { timeoutMs: 15_000, since: mark });
    await p.waitFor(PROMPT, { timeoutMs: 10_000, since: mark });
    expect(stub.requestCount(), "a routing preflight must not call the model").toBe(requestsAfterTurn);

    // And the session still takes the next turn.
    stub.enqueue({ kind: "text", text: "still working" });
    mark = p.output().length;
    p.writeLine("anything else?");
    await p.waitFor(/still working/, { timeoutMs: 30_000, since: mark });
    expect(stub.requestCount()).toBe(requestsAfterTurn + 1);
  }, 120_000);

  it("/route follows tabs, clear and resumed receipt history without spending", async () => {
    const id = newSessionId();
    await saveSession({ schemaVersion: 2, revision: 0, id, root: cwd,
      createdAt: Date.now(), updatedAt: Date.now(), title: "Hosted history", messages: [], approvals: {}, totalRwf: 0,
      routingReceipts: [{ taskId: "paid_call", chosen: { model: "receipt-test-model" }, considered: [], policy: {}, retries: 0, currency: "USD", actualMicros: 100 }],
    });
    const p = boot({ args: ["--resume", id] });
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });
    const command = async (input: string, expected: RegExp) => {
      const mark = p.output().length;
      p.writeLine(input);
      await p.waitFor(expected, { timeoutMs: 15_000, since: mark });
      await p.waitFor(PROMPT, { timeoutMs: 10_000, since: mark });
    };
    await command("/route summary", /1 calls/);
    await command("/tab new empty", /running/);
    await command("/route", /no hosted routing this session/);
    await command("/tab 1", /Hosted history|tab|receipt-test-model|calls/);
    await command("/route summary", /1 calls/);
    await command("/clear", /new thread/);
    await command("/route", /no hosted routing this session/);
    await command(`/history resume ${id}`, /resumed/);
    await command("/route summary", /1 calls/);
    expect(stub.requestCount()).toBe(0);
  }, 120_000);

  it("/route says there is no hosted routing on a direct-provider session, without disturbing it", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    const mark = p.output().length;
    p.writeLine("/route");
    await p.waitFor(/no hosted routing this session/, { timeoutMs: 15_000, since: mark });
    await p.waitFor(PROMPT, { timeoutMs: 10_000, since: mark });
    expect(stub.requestCount()).toBe(0);

    stub.enqueue({ kind: "text", text: "direct answer" });
    const turnMark = p.output().length;
    p.writeLine("hello");
    await p.waitFor(/direct answer/, { timeoutMs: 30_000, since: turnMark });
  }, 90_000);
});
