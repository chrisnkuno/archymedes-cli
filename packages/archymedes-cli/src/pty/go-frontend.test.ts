import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { bunExecutable, CONPTY, spawnArchymedes, type ArchymedesProcess } from "./harness";
import { settle, VirtualScreen } from "./virtual-screen";

/**
 * The Go front end (WS-6), end to end: the Bubble Tea binary in a real pty, driving this
 * repository's TypeScript agent over ACP, which talks to the Anthropic stub over HTTP.
 *
 * Skipped where Go is not installed, so a TS-only checkout still passes. What it guards is the seam
 * the port depends on: the handshake and extension events, an approval answered while a turn is
 * paused on it (the server once deadlocked there), streaming, and a clean frame after a resize.
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

describe.skipIf(!goAvailable() || CONPTY)("go front end over acp", () => {
  let binary: string;
  let stub: AnthropicStub;
  let cwd: string;
  let configDir: string;
  let proc: ArchymedesProcess | undefined;

  beforeAll(async () => {
    const out = await mkdtemp(path.join(tmpdir(), "archymedes-go-"));
    binary = path.join(out, "archymedes");
    execFileSync("go", ["build", "-o", binary, "./cmd/archymedes"], { cwd: REPO, stdio: "inherit" });
  }, 180_000);

  beforeEach(async () => {
    stub = await startAnthropicStub();
    cwd = await mkdtemp(path.join(tmpdir(), "archymedes-go-cwd-"));
    configDir = await mkdtemp(path.join(tmpdir(), "archymedes-go-cfg-"));
    await writeFile(path.join(cwd, "README.md"), "hi\n");
  });

  afterEach(async () => {
    proc?.kill();
    // The Go binary closes the agent's stdin on exit; wait so its bun child is not left running.
    await proc?.waitForExit(10_000).catch(() => undefined);
    proc = undefined;
    await stub.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function boot(cols = 100, rows = 30, extra: string[] = [], env: Record<string, string> = {}) {
    proc = spawnArchymedes({
      executable: binary,
      args: ["--no-mouse", "--provider", "anthropic", ...extra],
      cwd, cols, rows,
      env: {
        ANTHROPIC_API_KEY: "sk-test-fake",
        ANTHROPIC_BASE_URL: stub.url,
        ARCHYMEDES_CONFIG_DIR: configDir,
        ARCHYMEDES_FX_OFFLINE: "true",
        ARCHYMEDES_MODELS_OFFLINE: "true", // the model list never reaches past the stub
        ARCHYMEDES_AGENT: `${bunExecutable()} run ${path.join(REPO, "packages/archymedes-cli/src/archymedes.ts")}`,
        TZ: "UTC",
        ...env,
      },
    });
    return { proc, screen: new VirtualScreen(proc, cols, rows) };
  }

  it("streams a turn, asks before running a command, and runs it once allowed", async () => {
    stub.enqueue({ kind: "tool_call", toolName: "run_command", input: { command: "echo hello-from-go" }, text: "I'll run a command." });
    stub.enqueue({ kind: "text", text: "The command printed **hello-from-go**.", chunkSize: 6, chunkDelayMs: 10 });
    const { proc, screen } = boot();
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 }); // the model chip: the session is open

    proc.write("say hi via a command");
    proc.write("\r");
    await proc.waitFor("Allow this?", { timeoutMs: 30_000 });
    expect(await screen.text()).toContain("run echo hello-from-go");
    proc.write("y");

    await proc.waitFor(/── done/, { timeoutMs: 30_000 });
    const text = await screen.text();
    expect(text).toMatch(/run command +echo hello-from-go · exit 0/);
    expect(text).toContain("The command printed hello-from-go.");
    expect(text).not.toContain("Allow this?");
  }, 120_000);

  it("redraws a whole, fitting frame after the window shrinks", async () => {
    stub.enqueue({ kind: "text", text: `${"a long reply that has to wrap ".repeat(20)}end.` });
    const { proc, screen } = boot();
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 }); // the model chip: the session is open
    proc.write("hello\r");
    await proc.waitFor(/── done/, { timeoutMs: 30_000 });

    proc.resize(50, 16);
    screen.resize(50, 16);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { lines } = await screen.snapshot();
    expect(lines[0]).toContain("◇"); // the top bar: start button and Chat tab
    expect(lines[0]).toContain("Chat");
    expect(lines.at(-1)).toContain("F1"); // the dock
    expect(lines[0]).toContain("build"); // the mode pill survives the narrow header
    expect(lines.join("\n")).toContain("end.");
    // The input box is intact: both corners of its top and bottom borders on their own rows.
    expect(lines.filter((line) => line.startsWith("╭") && line.endsWith("╮"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("╰") && line.endsWith("╯"))).toHaveLength(1);
  }, 120_000);

  it("hands a headless run to the agent unchanged", async () => {
    stub.enqueue({ kind: "text", text: "headless answer" });
    const { proc } = boot(100, 30, ["--json", "say hi"]);
    const { exitCode } = await proc.waitForExit(60_000);
    expect(exitCode).toBe(0);
    // The agent's JSON lines, not a drawn screen: the Go UI never started.
    expect(proc.output()).toContain('"type"');
    expect(proc.output()).not.toContain("Ask Archymedes");
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
    const text = await second.screen.text();
    expect(text).toContain("┃ remember this request");
    expect(text).not.toContain("A R C H Y M E D E S"); // a resumed session is not a blank one
  }, 150_000);

  it("switches the model mid-session and the next request uses it", async () => {
    stub.enqueue({ kind: "text", text: "from the first model" });
    stub.enqueue({ kind: "text", text: "from the second model" });
    const { proc } = boot();
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    proc.write("one\r");
    await proc.waitFor(/── done/, { timeoutMs: 30_000 }); // a switch is refused mid-turn, by design
    proc.write("/model claude-opus-5\r");
    await proc.waitFor(/Model: claude-opus-5/, { timeoutMs: 30_000 });
    proc.write("two\r");
    await proc.waitFor("from the second model", { timeoutMs: 30_000 });
    const models = stub.requests().map((request) => request.model);
    expect(models[0]).toMatch(/sonnet/);
    expect(models.at(-1)).toBe("claude-opus-5");
    // The conversation carried across: the second request still contains the first exchange.
    expect(JSON.stringify(stub.requests().at(-1)?.messages)).toContain("from the first model");
  }, 150_000);

  it("shows the diff and the cost of a turn, and undo really reverts the file", async () => {
    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "note.txt", content: "written by the agent\n" }, text: "Writing it." });
    stub.enqueue({ kind: "text", text: "Wrote note.txt." });
    stub.enqueue({ kind: "text", text: "ok" });
    // Checkpoints are git-backed, as in a real project; outside a repository there is nothing to diff against.
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start"]]) {
      execFileSync("git", args, { cwd });
    }
    const { proc, screen } = boot(100, 40);
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    proc.write("write a note\r");
    await proc.waitFor("Allow this?", { timeoutMs: 30_000 });
    proc.write("y");
    await proc.waitFor(/── done/, { timeoutMs: 30_000 });
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("written by the agent\n");

    proc.write("/diff\r");
    // Read off the emulated screen: the cell renderer redraws only what changed, so a line on
    // screen is not one contiguous string in the output stream.
    await screenShows(screen, "+written by the agent");
    expect(await screen.text()).toMatch(/diff since the last checkpoint/);
    proc.write("/cost\r");
    await screenShows(screen, "Session cost");
    proc.write("/undo\r");
    await screenShows(screen, 'Reverted "');
    await expect(readFile(path.join(cwd, "note.txt"), "utf8")).rejects.toThrow();
  }, 150_000);

  it("is a desktop: F-keys open apps, and a key changed in the Keys app is saved and used after a restart", async () => {
    const { proc, screen } = boot(120, 32);
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    proc.write("\x1bOQ"); // F2
    await screenShows(screen, "files  ");
    proc.write("\x1b[18~"); // F7
    await screenShows(screen, "enter change");
    // Move to "files", rebind it to ctrl+e.
    for (let i = 0; i < 2; i++) proc.write("\x1b[B");
    proc.write("\r");
    await screenShows(screen, "press a key");
    proc.write("\x05"); // ctrl+e
    await screenShows(screen, "files is now ctrl+e");
    expect(await readFile(path.join(configDir, "keys.json"), "utf8")).toContain("ctrl+e");
    proc.kill();
    await proc.waitForExit(10_000).catch(() => undefined);

    const again = boot(120, 32);
    await again.proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    await screenShows(again.screen, /Files ctrl\+e|ctrl\+e Files/); // the dock shows the saved key, in whichever form fits
    again.proc.write("\x05");
    await screenShows(again.screen, "files  ");
  }, 150_000);

  it("draws the session's turns as charts in the Stats app", async () => {
    stub.enqueue({ kind: "text", text: "First answer." });
    stub.enqueue({ kind: "text", text: "Second answer, a little longer than the first one." });
    const { proc, screen } = boot(120, 32);
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    proc.write("one\r");
    await proc.waitFor(/── done/, { timeoutMs: 30_000 });
    const since = proc.output().length;
    proc.write("two\r");
    await proc.waitFor(/── done/, { since, timeoutMs: 30_000 });

    proc.write("\x1b[20~"); // F9
    await proc.waitFor("Tokens per turn", { timeoutMs: 10_000 });
    const text = await settle(screen);
    expect(text).toContain("2 turns");
    expect(text).toContain("Seconds per turn");
    expect(text).toMatch(/[\u2801-\u28ff]/); // the braille duration line
    expect(text).toContain("turn 2 ·");
    proc.write("\x1b[D"); // ← (the renderer redraws only the changed cells: read the screen, not the stream)
    expect(await settle(screen)).toContain("turn 1 ·");
  }, 120_000);

  it("welcomes a first run beside a credited photo, and shows the agent's edit as a diff in Changes", async () => {
    // A git repository, so Changes has a commit to compare against.
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]]) {
      execFileSync("git", args, { cwd });
    }
    stub.enqueue({ kind: "tool_call", toolName: "write_file", input: { path: "notes.md", content: "first line\nsecond line\n" }, text: "Writing it." });
    stub.enqueue({ kind: "text", text: "Wrote notes.md." });
    const { proc, screen } = boot(130, 34);
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    const home = await settle(screen);
    expect(home).toContain("New here? Three things:");
    expect(home).toContain("Unsplash"); // a photo's credit, beside the mark
    expect(home).toContain("Explain what this project does");

    proc.write("write notes\r");
    await proc.waitFor("Allow this?", { timeoutMs: 30_000 });
    proc.write("y");
    await proc.waitFor(/── done/, { timeoutMs: 30_000 });
    await proc.waitFor("First turn done", { timeoutMs: 10_000 });

    proc.write("\x1b[21~"); // F10
    await proc.waitFor("Changes", { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const changes = await settle(screen);
    expect(changes).toContain("notes.md");
    expect(changes).toContain("+first line");
    expect(changes).toMatch(/1 \+first line/); // its new line number in the gutter
  }, 120_000);

  it("opens a photo full size in the Gallery, turns it, and gives the screen back", async () => {
    const { proc, screen } = boot(130, 34, [], { ARCHYMEDES_PHOTOS: "local" }); // no network in tests
    await proc.waitFor("claude-sonnet", { timeoutMs: 60_000 });
    proc.write("\x1b[24~"); // F12
    await screenShows(screen, "built into Archymedes");
    expect(await settle(screen)).toMatch(/1 of 11|\d+ of 11/);
    const before = await settle(screen);
    proc.write("\x1b[C"); // →
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await settle(screen)).not.toEqual(before);
    proc.write("f");
    await screenShows(screen, "fit cover");
    proc.write("\x1b"); // esc
    await screenShows(screen, "Ask Archymedes");
  }, 120_000);

  it("sets up a provider on first run and opens the session with it", async () => {
    stub.enqueue({ kind: "text", text: "hello after setup" });
    proc = spawnArchymedes({
      executable: binary,
      args: ["--no-mouse"],
      cwd, cols: 100, rows: 30,
      env: {
        // Nothing configured: no key in the environment, an empty settings directory.
        ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined, ARCHYMEDES_PROVIDER: undefined,
        ANTHROPIC_BASE_URL: stub.url,
        ARCHYMEDES_CONFIG_DIR: configDir,
        ARCHYMEDES_FX_OFFLINE: "true",
        ARCHYMEDES_MODELS_OFFLINE: "true", // the model list never reaches past the stub
        ARCHYMEDES_AGENT: `${bunExecutable()} run ${path.join(REPO, "packages/archymedes-cli/src/archymedes.ts")}`,
      },
    });
    const screen = new VirtualScreen(proc, 100, 30);
    await proc.waitFor("Welcome to Archymedes", { timeoutMs: 60_000 });
    proc.write("\x1b[B"); // Free → Anthropic
    proc.write("\r");
    await proc.waitFor("Get a key", { timeoutMs: 10_000 });
    proc.write("sk-ant-first-run");
    proc.write("\r");
    await proc.waitFor("claude-sonnet", { timeoutMs: 30_000 });
    expect(await screen.text()).not.toContain("sk-ant-first-run");
    proc.write("hi\r");
    await proc.waitFor("hello after setup", { timeoutMs: 30_000 });
    // Saved where `archymedes settings` keeps it, so the next start needs no setup.
    const saved = await readFile(path.join(configDir, "settings.json"), "utf8").catch(async () => readdirText(configDir));
    expect(saved).toContain("sk-ant-first-run");
  }, 150_000);
});

async function screenShows(screen: VirtualScreen, text: string | RegExp, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const shown = await screen.text();
    if (typeof text === "string" ? shown.includes(text) : text.test(shown)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`screen never showed ${String(text)}:\n${await screen.text()}`);
}

async function readdirText(directory: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(directory, { recursive: true });
  const texts = await Promise.all(names.map((name) => readFile(path.join(directory, String(name)), "utf8").catch(() => "")));
  return texts.join("\n");
}
