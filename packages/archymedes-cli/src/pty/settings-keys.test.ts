/** Key setup and menu navigation, against the real CLI: /settings save, add-a-key, secrets hygiene. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { spawnArchymedes, type ArchymedesProcess } from "./harness";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const CTRL_G = "\x07";
const CTRL_U = "\x15";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function strip(raw: string): string {
  return raw.replace(/\x1b\[\?2026h[\s\S]*?\x1b\[\?2026l/g, "").replace(/\x1b7[\s\S]*?\x1b8/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b./g, "");
}

let stub: AnthropicStub;
let cwd = "";
let configDir = "";
let p: ArchymedesProcess;
let mark = 0;
const since = () => { const m = mark; mark = p.output().length; return m; };

async function promptHealthy(): Promise<void> {
  p.write(CTRL_U);
  await sleep(300);
  const m = since();
  p.write("/cost");
  p.write(ENTER);
  await p.waitFor(/Session cost/i, { timeoutMs: 15_000, since: m });
  since();
}

async function settingsFile(): Promise<Record<string, string>> {
  return JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8"));
}

beforeAll(async () => {
  stub = await startAnthropicStub();
  cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-settings-"));
  configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-settingscfg-"));
  await writeFile(path.join(cwd, "hello.txt"), "hello probe");
  p = spawnArchymedes({ cwd, rows: 30, args: ["--layout", "scrollback", "--currency", "USD"], env: {
    ANTHROPIC_API_KEY: "sk-ant-boot-key", ANTHROPIC_BASE_URL: stub.url,
    ARCHYMEDES_CONFIG_DIR: configDir, ARCHYMEDES_FX_OFFLINE: "true", TZ: "UTC",
  }});
  await p.waitFor(/›/, { timeoutMs: 60_000 });
  mark = p.output().length;
}, 90_000);

afterAll(async () => {
  try { p.kill(); } catch { /* exited */ }
  await stub.close();
  await rm(cwd, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

describe("keys and menus", () => {
  it("/settings edits an enumerated field through the filtered list", async () => {
    await promptHealthy();
    const m = since(); p.write("/settings"); p.write(ENTER);
    await p.waitFor(/Control language/i, { timeoutMs: 20_000, since: m });
    // Filter to the language field rather than counting rows: the menu is sectioned and its order
    // is not part of this contract. Enter opens its value list, typing narrows that too.
    p.write("control language");
    await sleep(800);
    p.write(ENTER);
    await sleep(800);
    p.write("deut");
    await sleep(800);
    p.write(ENTER);
    await p.waitFor(/saved in this menu/i, { timeoutMs: 10_000, since: m });
    p.write(ESC);
    await p.waitFor(/settings saved/i, { timeoutMs: 15_000, since: m });
    expect((await settingsFile()).ARCHYMEDES_LANGUAGE).toBe("de");
    await promptHealthy();
  }, 90_000);

  it("/settings saves a pasted secret without ever showing it", async () => {
    await promptHealthy();
    const m = since(); p.write("/settings"); p.write(ENTER);
    await p.waitFor(/Control language/i, { timeoutMs: 20_000, since: m });
    // Filtered to the Anthropic key, so the test does not depend on where the field sits.
    p.write("anthropic api key");
    await sleep(800);
    p.write(ENTER);
    await p.waitFor(/paste hidden/i, { timeoutMs: 10_000, since: m });
    const secret = "sk-ant-probe-secret-xyz";
    p.write(secret);
    // Typing gets feedback — one bullet per character — so the prompt never looks frozen.
    await p.waitFor(/•{23}/, { timeoutMs: 10_000, since: m });
    p.write(ENTER);
    await p.waitFor(/saved in this menu/i, { timeoutMs: 10_000, since: m });
    p.write(ESC);
    await p.waitFor(/settings saved/i, { timeoutMs: 15_000, since: m });
    expect((await settingsFile()).ANTHROPIC_API_KEY).toBe(secret);
    // The secret is in the file but never appeared on screen…
    expect(strip(p.output()).includes(secret)).toBe(false);
    // …and never reached the persisted prompt history either.
    const history = await readFile(path.join(configDir, "history.json"), "utf8").catch(() => "[]");
    expect(history.includes(secret)).toBe(false);
    await promptHealthy();
  }, 120_000);

  it("/settings refuses a bad URL inline and saves nothing", async () => {
    await promptHealthy();
    const before: Record<string, string> = await settingsFile().catch(() => ({}));
    const m = since(); p.write("/settings"); p.write(ENTER);
    await p.waitFor(/Control language/i, { timeoutMs: 20_000, since: m });
    // Filtered to the Anthropic base URL; the ask prompt below proves the cursor landed there —
    // the row text alone is already on screen from the menu list and proves nothing.
    p.write("anthropic base");
    await sleep(800);
    p.write(ENTER);
    await p.waitFor(/Anthropic base URL \(- clears/i, { timeoutMs: 10_000, since: m });
    p.write("not-a-url");
    p.write(ENTER);
    await p.waitFor(/complete URL|HTTPS/i, { timeoutMs: 10_000, since: m });
    p.write(ESC);
    await p.waitFor(/settings saved/i, { timeoutMs: 15_000, since: m });
    expect((await settingsFile()).ANTHROPIC_BASE_URL ?? before.ANTHROPIC_BASE_URL).toBe(before.ANTHROPIC_BASE_URL);
    await promptHealthy();
  }, 120_000);

  it("model picker add-a-key row opens settings and comes back", async () => {
    await promptHealthy();
    const m = since(); p.write("/model"); p.write(ENTER);
    await p.waitFor(/Add a key|Select model|claude/i, { timeoutMs: 20_000, since: m });
    p.write("groq");
    await sleep(900);
    // First row should now be the Groq add-a-key row; move onto it explicitly in case it is not.
    p.write(DOWN);
    await sleep(400);
    p.write(ENTER);
    // The add-a-key row opens the focused provider-key list, not the full menu.
    await p.waitFor(/Groq API key/i, { timeoutMs: 20_000, since: m });
    p.write(ESC);
    await p.waitFor(/settings saved/i, { timeoutMs: 15_000, since: m });
    await promptHealthy();
  }, 120_000);

  it("/providers names what is configured", async () => {
    await promptHealthy();
    const m = since(); p.write("/providers"); p.write(ENTER);
    await p.waitFor(/pricing:/i, { timeoutMs: 15_000, since: m });
    expect(strip(p.output().slice(m)).toLowerCase()).toMatch(/anthropic/);
  }, 60_000);

  it("/settings field list filters as you type", async () => {
    await promptHealthy();
    const m = since(); p.write("/settings"); p.write(ENTER);
    await p.waitFor(/Control language/i, { timeoutMs: 20_000, since: m });
    p.write("anthropic base");
    await sleep(900);
    // The only row left matching is the base-URL field: Enter opens its ask prompt, which the
    // unfiltered list could never land on first try.
    p.write(ENTER);
    await p.waitFor(/Anthropic base URL \(- clears/i, { timeoutMs: 10_000, since: m });
    // Leave without changing anything: clear is a no-op on an unset field.
    p.write("-");
    p.write(ENTER);
    await p.waitFor(/cleared/i, { timeoutMs: 10_000, since: m });
    p.write(ESC);
    await p.waitFor(/settings saved/i, { timeoutMs: 15_000, since: m });
    await promptHealthy();
  }, 90_000);

  it("palette with no match cancels cleanly and bills nothing", async () => {
    await promptHealthy();
    const before = stub.requestCount();
    const m = since(); p.write(CTRL_G);
    await p.waitFor(/❯|>/, { timeoutMs: 15_000, since: m });
    p.write("zzz-no-such-command");
    await p.waitFor(/no match/i, { timeoutMs: 10_000, since: m });
    p.write(ENTER);
    // Escape twice: the first clears the filter, the second leaves the palette. Either order of
    // arrival still ends at the prompt, which promptHealthy then proves.
    await sleep(500);
    p.write(ESC);
    await sleep(400);
    p.write(ESC);
    await sleep(400);
    expect(stub.requestCount()).toBe(before);
    await promptHealthy();
  }, 60_000);
});

describe("archymedes settings subcommand", () => {
  it("opens the full menu outside a session and cancels cleanly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "archymedes-settingscmd-"));
    const cfg = await mkdtemp(path.join(os.tmpdir(), "archymedes-settingscmdcfg-"));
    const session = spawnArchymedes({ cwd: dir, rows: 30, args: ["settings", "--currency", "USD"], env: {
      ARCHYMEDES_CONFIG_DIR: cfg, ARCHYMEDES_FX_OFFLINE: "true", TZ: "UTC",
    }});
    try {
      // Full list (not the providers focus). Escape leaves via done, which saves (a no-op when
      // nothing changed) and exits zero.
      await session.waitFor(/Control language/i, { timeoutMs: 60_000 });
      session.write(ESC);
      const result = await session.waitForExit(20_000);
      expect(result.exitCode).toBe(0);
      expect(strip(session.output()).toLowerCase()).toMatch(/settings saved to/);
    } finally {
      try { session.kill(); } catch { /* exited */ }
      await rm(dir, { recursive: true, force: true });
      await rm(cfg, { recursive: true, force: true });
    }
  }, 120_000);
});

