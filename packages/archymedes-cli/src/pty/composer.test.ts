/**
 * The input box behaves like a coding agent's composer, under a real pty.
 *
 * Enter moves the message into the transcript and leaves the box empty; typing while a turn runs
 * drafts the next message in the box and never lands in the streaming answer; Enter on that draft
 * queues it as the next turn; Escape interrupts. Asserted on the emulated screen, because each of
 * these is about what is visible where, not about bytes in the stream.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { CONPTY, spawnArchymedes, type ArchymedesProcess } from "./harness";
import { settle, VirtualScreen } from "./virtual-screen";

const COLS = 90;
const ROWS = 26;
let stub: AnthropicStub;
let cwd: string;
let configDir: string;
let p: ArchymedesProcess;
let screen: VirtualScreen;

const inputRow = async () => {
  const { lines } = await screen.snapshot();
  // The input row carries the prompt marker: `›` when it is the user's turn, `…` while the agent works.
  return [...lines].reverse().find((line) => line.startsWith("│ ›") || line.startsWith("│ …")) ?? "";
};

beforeEach(async () => {
  stub = await startAnthropicStub();
  cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-composer-"));
  configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-composer-cfg-"));
  p = spawnArchymedes({ cwd, cols: COLS, rows: ROWS, args: ["--currency", "USD"], env: {
    ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: stub.url, ARCHYMEDES_CONFIG_DIR: configDir,
    ARCHYMEDES_FX_OFFLINE: "true", ARCHYMEDES_NO_MOTION: "1", TZ: "UTC", TYPESAFE_API_KEY: undefined,
  } });
  screen = new VirtualScreen(p, COLS, ROWS);
  await p.waitFor(/›/, { timeoutMs: 60_000 });
});

afterEach(async () => {
  try { p.kill(); } catch { /* exited */ }
  await stub.close();
  await rm(cwd, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

const slow = (text: string, words = 60) => ({ kind: "text" as const, text: `${text} ${"slow ".repeat(words)}`, chunkSize: 8, chunkDelayMs: 100 });

describe.skipIf(CONPTY)("the composer", () => {
  it("empties on Enter, and a draft typed mid-turn stays out of the streaming answer", async () => {
    stub.enqueue(slow("First answer."));
    p.write("explain the project layout\r");
    await p.waitFor(/First answer/, { timeoutMs: 20_000 });
    // A fixed pause, not `settle`: the answer is still streaming, which is the point — the screen
    // only settles once the turn is over.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await inputRow()).not.toContain("explain the project layout");
    expect(await inputRow()).toContain("Esc interrupts");
    // Busy and ready look different: the ready marker comes back only when the turn is over.
    expect(await inputRow()).toMatch(/^│ …/);

    p.write("my next idea");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await inputRow()).toContain("my next idea");
    const answer = (await screen.text()).split("\n").find((line) => line.startsWith("First answer"));
    expect(answer).toBeDefined();
    expect(answer).not.toContain("my next idea");
  }, 60_000);

  it("queues a message sent mid-turn and runs it next, echoed once", async () => {
    stub.enqueue(slow("First answer.", 40));
    stub.enqueue({ kind: "text", text: "Answer to the queued message." });
    p.write("first question\r");
    await p.waitFor(/First answer/, { timeoutMs: 20_000 });
    p.write("second question\r");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await inputRow()).toContain("1 queued");
    await p.waitFor(/Answer to the queued message/, { timeoutMs: 30_000 });
    const text = await settle(screen, 300);
    expect(text.split("\n").filter((line) => line.includes("│ second question │"))).toHaveLength(1);
    expect(stub.requestCount()).toBe(2);
  }, 60_000);

  it("interrupts the running turn on Escape", async () => {
    stub.enqueue(slow("Long answer.", 300));
    p.write("write a lot\r");
    await p.waitFor(/Long answer/, { timeoutMs: 20_000 });
    const mark = p.output().length;
    p.write("\x1b");
    await p.waitFor(/interrupted|cancelled|completed/i, { timeoutMs: 10_000, since: mark });
    // Back at an empty, usable prompt.
    await settle(screen, 300);
    expect((await inputRow()).trim()).toBe("│ ›");
  }, 60_000);
});
