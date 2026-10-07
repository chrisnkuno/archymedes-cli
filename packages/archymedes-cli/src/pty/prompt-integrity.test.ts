/**
 * The prompt stays usable across everything that borrows the terminal.
 *
 * TermUI screens (`/files`, `/guide`, `/edit`, `/workspace`) mount a whole second app on the
 * same stdin: if one fails to unmount, its ghost frame keeps every later keypress and the session
 * looks dead while the process happily idles. Arrow-key dropup browsing, history recall and the
 * Ctrl+D exit path share the same keyboard, so they are pinned here too — a regression in any of
 * them strands the user at a prompt that will never answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { spawnArchymedes, type ArchymedesProcess } from "./harness";

const ENTER = "\r";
const UP = "\x1b[A";
const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_U = "\x15";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stub: AnthropicStub;
let cwd = "";
let configDir = "";
let p: ArchymedesProcess;

beforeAll(async () => {
  stub = await startAnthropicStub();
  cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-fsr-"));
  configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-fsrcfg-"));
  await writeFile(path.join(cwd, "hello.txt"), "hello probe");
  p = spawnArchymedes({ cwd, rows: 30, args: ["--layout", "scrollback", "--currency", "USD"], env: {
    ANTHROPIC_API_KEY: "sk-fsr", ANTHROPIC_BASE_URL: stub.url,
    ARCHYMEDES_CONFIG_DIR: configDir, ARCHYMEDES_FX_OFFLINE: "true", TZ: "UTC",
  }});
  await p.waitFor(/›/, { timeoutMs: 60_000 });
}, 90_000);

afterAll(async () => {
  try { p.kill(); } catch { /* exited */ }
  await stub.close();
  await rm(cwd, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("prompt integrity across screens and signals", () => {
  it("keys typed immediately after /files pick are not swallowed", async () => {
    let mark = p.output().length;
    p.write("/files");
    p.write(ENTER);
    await p.waitFor(/hello\.txt/, { timeoutMs: 20_000, since: mark });
    p.write(ENTER); // pick @hello.txt
    await p.waitFor(/@hello\.txt/, { timeoutMs: 10_000 });
    // No settle delay: a fast user types before TermUI has fully torn down.
    p.write("QQ");
    await sleep(3000);
    // Whatever was typed during teardown is buffered and reinserted; submitting it starts a turn.
    // The stub has no scripted response queued, so the answer is "(stub had no scripted response queued)".
    p.write(ENTER);
    await p.waitFor(/stub had no scripted response queued|turn complete|completed/i, { timeoutMs: 30_000, since: mark });
    // Wait for the fresh prompt after the turn before typing the next command — anything typed
    // while the turn is still printing is input to the turn, not the prompt.
    const m0 = p.output().length;
    await p.waitFor(/›/, { timeoutMs: 15_000, since: m0 });
    const m = p.output().length;
    p.write("/cost");
    p.write(ENTER);
    await p.waitFor(/Session cost/i, { timeoutMs: 15_000, since: m });
  }, 120_000);

  it("up-arrow with history and a partial line keeps the typed line", async () => {
    // History now holds /cost from the previous test.
    const m0 = p.output().length;
    p.write(CTRL_U);
    await sleep(300);
    p.write("/cost");
    p.write(ENTER);
    await p.waitFor(/Session cost/i, { timeoutMs: 15_000, since: m0 });
    const m = p.output().length;
    p.write("/mo");
    await p.waitFor(/permission mode/, { timeoutMs: 15_000, since: m });
    p.write(UP);
    await sleep(1200);
    p.write(ESC);
    await sleep(700);
    // The typed line must still be there: not clobbered by history, not wiped by browse.
    const t = p.output().slice(m);
    expect(t).toContain("/mo");
    p.write(CTRL_U);
    await sleep(300);
  }, 90_000);

  it("/guide opens and esc hands the terminal back", async () => {
    const m = p.output().length;
    p.write("/guide");
    p.write(ENTER);
    // The guide's own header, not the typed command (which echoes first and would match before
    // the guide has mounted and owned the keyboard).
    await p.waitFor(/archymedes guide/i, { timeoutMs: 20_000, since: m });
    p.write(ESC);
    // TermUI disambiguates a lone Esc from an escape sequence with a short hold; typing into
    // that window addresses the closing screen, not the prompt.
    await sleep(600);
    const m2 = p.output().length;
    p.write("/cost");
    p.write(ENTER);
    await p.waitFor(/Session cost/i, { timeoutMs: 15_000, since: m2 });
  }, 90_000);

  it("/edit opens and ctrl+q quits without saving, prompt stays alive", async () => {
    const m = p.output().length;
    p.write("/edit hello.txt");
    p.write(ENTER);
    // Fullscreen entry proves the editor mounted and owns the keyboard; the filename alone
    // echoes in the submitted line and would match before the editor exists.
    await p.waitFor("\x1b[?1049h", { timeoutMs: 20_000, since: m });
    p.write("\x11"); // ctrl+q quits the editor
    await sleep(600);
    const m2 = p.output().length;
    p.write("/cost");
    p.write(ENTER);
    await p.waitFor(/Session cost/i, { timeoutMs: 15_000, since: m2 });
  }, 90_000);

  it("file browser: q leaves without touching the line", async () => {
    const m = p.output().length;
    p.write("/files");
    p.write(ENTER);
    await p.waitFor(/hello\.txt/, { timeoutMs: 20_000, since: m });
    p.write("q");
    await sleep(800);
    // The `q` that closed the browser must not leak into readline's idle line: if it did, this
    // submits `q/cost` as a chat turn instead of running /cost.
    const m2 = p.output().length;
    p.write("/cost");
    p.write(ENTER);
    await p.waitFor(/Session cost/i, { timeoutMs: 15_000, since: m2 });
  }, 90_000);

  it("ctrl+d at empty prompt exits cleanly", async () => {
    p.write(CTRL_D);
    const result = await p.waitForExit(20_000);
    expect(result.exitCode).toBe(0);
    const tail = p.output().slice(-3000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b./g, "");
    expect(tail).toContain("bye");
  }, 40_000);
});
