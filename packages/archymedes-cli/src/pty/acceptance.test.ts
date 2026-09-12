import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bunExecutable, spawnArchymedes, type ArchymedesProcess, type SpawnArchymedesOptions } from "./harness";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";

/**
 * The installed binary in the terminals people actually run it in.
 *
 * The rest of the pty suite drives Archymedes through node-pty directly. This file adds the layers
 * that sit between the binary and a real user: a terminal multiplexer, a bracketed paste, and
 * non-ASCII input that has to survive echo *and* the trip to the model. Component-width unit tests
 * cannot see any of this.
 */

const PROMPT = /›|auto >/;
const ARCHYMEDES_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../archymedes.ts");
const plain = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const lastUserMessage = (stub: AnthropicStub): string => {
  const messages = stub.requests().at(-1)?.messages ?? [];
  const user = [...messages].reverse().find((message) => message.role === "user");
  return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
};

describe("the installed binary in a real terminal", () => {
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let procs: ArchymedesProcess[] = [];

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-acceptance-"));
    configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-acceptance-config-"));
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

  it("runs a whole turn inside tmux and gives the multiplexer back on exit", async () => {
    const socket = path.join(configDir, "tmux.sock");
    const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", env: process.env });
    const forwarded = [
      `ANTHROPIC_API_KEY=sk-test-fake`,
      `ANTHROPIC_BASE_URL=${stub.url}`,
      `ARCHYMEDES_CONFIG_DIR=${configDir}`,
      `ARCHYMEDES_FX_OFFLINE=true`,
      `TZ=UTC`,
      `ARCHYMEDES_AUTO_UPDATE=off`,
    ].flatMap((pair) => ["-e", pair]);

    const started = tmux(
      "new-session", "-d", "-x", "120", "-y", "40", "-s", "s",
      ...forwarded,
      `${bunExecutable()} run ${ARCHYMEDES_ENTRY} --currency USD --auto`,
    );
    expect(started.status, started.stderr).toBe(0);

    const capture = () => tmux("capture-pane", "-p", "-t", "s").stdout;
    const waitForPane = async (pattern: RegExp, tries = 80) => {
      for (let attempt = 0; attempt < tries; attempt += 1) {
        if (pattern.test(capture())) return capture();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      throw new Error(`tmux pane never matched ${pattern}:\n${capture()}`);
    };

    try {
      await waitForPane(PROMPT);
      stub.enqueue({ kind: "text", text: "reply from inside tmux" });
      tmux("send-keys", "-t", "s", "say hi", "Enter");
      await waitForPane(/reply from inside tmux/);
      await waitForPane(PROMPT); // the turn closed and the prompt came back, all under tmux

      // Ctrl+C at the idle prompt is the ordinary way out; with one pane, the session ends with it.
      tmux("send-keys", "-t", "s", "C-c");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (tmux("list-sessions").status !== 0) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(tmux("list-sessions").status, "tmux session should be gone after the CLI exits").not.toBe(0);
    } finally {
      tmux("kill-server");
    }
  }, 90_000);

  it("sends CJK and emoji input to the model exactly as typed", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    const message = "fix the 索引 bug in café.ts 🙏 then 明日 deploy";
    stub.enqueue({ kind: "text", text: "understood" });
    const mark = p.output().length;
    p.write(message);
    await p.waitFor("deploy", { timeoutMs: 10_000, since: mark });
    p.write("\r");
    await p.waitFor(/understood/, { timeoutMs: 20_000, since: mark });

    // Echoed intact (no replacement characters) and delivered to the model byte-for-byte.
    expect(p.output().slice(mark)).not.toMatch(/�/);
    expect(lastUserMessage(stub)).toBe(message);
  }, 60_000);

  it("strips bracketed-paste markers and submits a pasted line as one message", async () => {
    const p = boot();
    await p.waitFor(PROMPT, { timeoutMs: 30_000 });

    stub.enqueue({ kind: "text", text: "queued" });
    const mark = p.output().length;
    // A terminal wraps a paste in \x1b[200~ … \x1b[201~. Those bytes must never reach the model.
    p.write("\x1b[200~run the migration against staging\x1b[201~");
    await new Promise((resolve) => setTimeout(resolve, 300));
    p.write("\r");
    await p.waitFor(/queued/, { timeoutMs: 20_000, since: mark });

    expect(stub.requestCount()).toBe(1);
    const sent = lastUserMessage(stub);
    expect(sent).toContain("run the migration against staging");
    expect(sent).not.toMatch(/200~|201~|\x1b\[20[01]~/);
  }, 60_000);
});
