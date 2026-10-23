import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { bunExecutable, CONPTY, spawnArchymedes, type ArchymedesProcess } from "./harness";
import { VirtualScreen } from "./virtual-screen";

/**
 * Plain `friday`, end to end, on its default engine: the Go engine inside the binary (WS-35), in a
 * real pty, talking to the Anthropic stub over HTTP with its native Messages client. No engine is
 * named anywhere here; that is the point. The TypeScript agent is still given (ARCHYMEDES_AGENT),
 * as the npm launcher gives it, for the methods the Go engine forwards (the model list).
 *
 * Skipped where Go is not installed, so a TS-only checkout still passes.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function goAvailable(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!goAvailable() || CONPTY)("plain friday runs on the Go engine", () => {
  let binary: string;
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: ArchymedesProcess | undefined;

  beforeAll(async () => {
    const out = await mkdtemp(path.join(tmpdir(), "friday-go-engine-"));
    binary = path.join(out, "friday");
    execFileSync("go", ["build", "-o", binary, "./cmd/friday"], { cwd: REPO, stdio: "inherit" });
  }, 180_000);

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(tmpdir(), "friday-go-engine-cwd-"));
    configDir = await mkdtemp(path.join(tmpdir(), "friday-go-engine-cfg-"));
    await writeFile(path.join(cwd, "README.md"), "hi\n");
  });

  afterEach(async () => {
    proc?.kill();
    await proc?.waitForExit(10_000).catch(() => undefined);
    proc = undefined;
    await stub.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function boot(cols = 100, rows = 30, extra: string[] = []) {
    proc = spawnArchymedes({
      executable: binary,
      args: ["--no-mouse", "--provider", "anthropic", ...extra],
      cwd, cols, rows,
      env: {
        ANTHROPIC_API_KEY: "sk-test-fake",
        ANTHROPIC_BASE_URL: stub.url,
        ARCHYMEDES_CONFIG_DIR: configDir,
        ARCHYMEDES_FX_OFFLINE: "true",
        ARCHYMEDES_MODELS_OFFLINE: "true",
        ARCHYMEDES_TITLES: "off", // one scripted reply per request: no title call in between
        ARCHYMEDES_TEST_FIRST: "off",
        ARCHYMEDES_AGENT: `${bunExecutable()} run ${path.join(REPO, "packages/friday-cli/src/friday.ts")}`,
        TZ: "UTC",
        ARCHYMEDES_WALLPAPER: "off",
      },
    });
    return { proc, screen: new VirtualScreen(proc, cols, rows) };
  }

  it("is the Go engine: its session is stored where the Go engine keeps them", async () => {
    stub.enqueue({ kind: "text", text: "hello from the go engine" });
    const { proc } = boot();
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    proc.write("hi\r");
    await proc.waitFor(/── done/, { timeoutMs: 30_000 });
    expect(await readdir(path.join(cwd, ".archymedes", "go-sessions"))).toHaveLength(1);
    // The request reached the stub as the native client sends it: system prompt as a cached block.
    expect(JSON.stringify(stub.requests()[0]?.system)).toContain("ephemeral");
  }, 120_000);

  it("streams a turn, asks before running a command, and runs it once allowed", async () => {
    stub.enqueue({ kind: "tool_call", toolName: "run_command", input: { command: "echo hello-from-go | tee /dev/null" }, text: "I'll run a command." });
    stub.enqueue({ kind: "text", text: "The command printed **hello-from-go**.", chunkSize: 6, chunkDelayMs: 10 });
    stub.enqueue({ kind: "text", text: "Nothing to verify: it only printed." });
    const { proc, screen } = boot();
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    proc.write("say hi via a command\r");
    await proc.waitFor("Allow this?", { timeoutMs: 30_000 });
    expect(await screen.text()).toContain("run echo hello-from-go");
    proc.write("y");
    await proc.waitFor(/── done/, { timeoutMs: 30_000 });
    const text = await screen.text();
    expect(text).toMatch(/run command +echo hello-from-go \| tee \/dev\/null · exit 0/);
    expect(text).toContain("The command printed hello-from-go.");
  }, 120_000);

  it("resumes the latest session with its conversation on screen", async () => {
    stub.enqueue({ kind: "text", text: "first reply from before" });
    const first = boot();
    await first.proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    first.proc.write("remember this request\r");
    await first.proc.waitFor(/── done/, { timeoutMs: 30_000 });
    first.proc.write("\x03");
    first.proc.write("\x03");
    await first.proc.waitForExit(15_000);

    const second = boot(100, 30, ["--resume", "latest"]);
    await second.proc.waitFor("first reply from before", { timeoutMs: 60_000 });
    expect(await second.screen.text()).toContain("┃ remember this request");
  }, 150_000);

  it("switches the model mid-session and keeps the conversation", async () => {
    stub.enqueue({ kind: "text", text: "from the first model" });
    stub.enqueue({ kind: "text", text: "from the second model" });
    const { proc } = boot();
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    proc.write("one\r");
    await proc.waitFor(/── done/, { timeoutMs: 30_000 });
    proc.write("/model claude-opus-5\r");
    await proc.waitFor(/Model: claude-opus-5/, { timeoutMs: 30_000 });
    proc.write("two\r");
    await proc.waitFor("from the second model", { timeoutMs: 30_000 });
    const models = stub.requests().map((request) => request.model);
    expect(models[0]).toMatch(/sonnet/);
    expect(models.at(-1)).toBe("claude-opus-5");
    expect(JSON.stringify(stub.requests().at(-1)?.messages)).toContain("from the first model");
  }, 150_000);

  it("sets up a provider on first run, through the TypeScript agent, and runs the session on Go", async () => {
    stub.enqueue({ kind: "text", text: "hello after setup" });
    proc = spawnArchymedes({
      executable: binary,
      args: ["--no-mouse"],
      cwd, cols: 100, rows: 30,
      env: {
        ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined, ARCHYMEDES_PROVIDER: undefined,
        ANTHROPIC_BASE_URL: stub.url,
        ARCHYMEDES_CONFIG_DIR: configDir,
        ARCHYMEDES_FX_OFFLINE: "true",
        ARCHYMEDES_MODELS_OFFLINE: "true",
        ARCHYMEDES_TITLES: "off",
        ARCHYMEDES_AGENT: `${bunExecutable()} run ${path.join(REPO, "packages/friday-cli/src/friday.ts")}`,
      },
    });
    const screen = new VirtualScreen(proc, 100, 30);
    await proc.waitFor("Welcome to Friday", { timeoutMs: 60_000 });
    await proc.waitFor("Anthropic", { timeoutMs: 30_000 });
    proc.write("\x1b[B"); // Free → Claude (subscription)
    proc.write("\x1b[B"); // Claude → Codex (ChatGPT plan)
    proc.write("\x1b[B"); // Codex → Anthropic
    proc.write("\r");
    await proc.waitFor("Get a key", { timeoutMs: 10_000 });
    proc.write("sk-ant-first-run");
    proc.write("\r");
    await screenShows(screen, "type to filter", 30_000);
    proc.write("\r");
    await proc.waitFor("claude-sonnet", { timeoutMs: 30_000 });
    proc.write("hi\r");
    await proc.waitFor("hello after setup", { timeoutMs: 30_000 });
    expect(await readdir(path.join(cwd, ".archymedes", "go-sessions"))).toHaveLength(1);
  }, 150_000);

  it("says plainly when a command is not in the Go engine yet, and how to get it", async () => {
    const { proc, screen } = boot(120, 32);
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    proc.write("/cost\r");
    // A toast, gone again after a few seconds: seen once is the assertion.
    await screenShows(screen, "not in the Go engine yet");
  }, 120_000);
});

async function screenShows(screen: VirtualScreen, text: string, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await screen.text()).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`screen never showed ${text}:\n${await screen.text()}`);
}
