/**
 * Demo GIF recorder: drives the REAL CLI through the deterministic SSE stub (the same
 * fixture the PTY journey benchmarks use — no live model, no invented transcript),
 * snapshots the rendered terminal at four scripted moments, and writes PNG frames to
 * `docs/demo/` for GIF assembly.
 *
 * Rendering: each frame is one `<pre>` fed through headless Chrome with the brand
 * background, so the frames match the landing page palette exactly.
 * Usage: bun run tooling/dev/capture-demo-gif.ts
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnArchymedes } from "../../packages/archymedes-cli/src/pty/harness";
import { startAnthropicStub, type AnthropicStub } from "../../packages/archymedes-cli/src/pty/anthropic-stub";

const OUT_DIR = new URL("../../docs/demo/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PROMPT = /›|auto >/;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const COLS = 100;
const ROWS = 30;
const FG = "#e8e2d6";
const DIM = "#a89f8f";
const BG = "#191714";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** Bold/intensity → brighter text so emphasis survives in the flat HTML render. */
const styled = (s: string) =>
  esc(s)
    .replaceAll("\x1b[1m", "")
    .replaceAll(/[\x00-\x08\x0b-\x1f]|\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b./g, "");

async function writeFrame(name: string, inner: string): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; background:${BG}; display:grid; place-items:center; }
    pre {
      color:${FG}; font:13.5px/1.42 Consolas, monospace; white-space:pre; margin:0;
    }
    .dim { color:${DIM}; }
  </style></head><body><pre>${inner}</pre></body></html>`;
  const file = path.join(os.tmpdir(), `archymedes-frame-${name}.html`);
  await writeFile(file, html, "utf8");
  const png = path.resolve(OUT_DIR, `${name}.png`);
  const win = path.resolve(OUT_DIR).replaceAll("\\", "/");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(CHROME, [
      "--headless", "--disable-gpu", "--hide-scrollbars",
      `--screenshot=${png}`, `--window-size=1000,560`, `file:///${win}/${name}.html`,
    ], { stdio: "ignore" });
    child.on("exit", resolve);
    child.on("error", reject);
  });
  await writeFile(path.join(OUT_DIR, `${name}.html`), html, "utf8");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Slice the full session transcript to the visible window, keeping the prompt line last. */
function lastScreen(proc: { output(): string }): string {
  const raw = proc.output();
  const tail = raw.slice(-6000);
  const lines = styled(tail).split("\r\n").join("\n").split("\n");
  return lines.slice(-ROWS + 2).join("\n");
}

const session = { proc: null as null | ReturnType<typeof spawnArchymedes>, stub: null as null | AnthropicStub };

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const repo = await mkdtemp(path.join(os.tmpdir(), "archymedes-demo-repo-"));
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "demo@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "demo"], { cwd: repo });
  await writeFile(path.join(repo, "parser.ts"), "export function parse(input: string) {\n  return input.trim();\n}\n", "utf8");
  await writeFile(path.join(repo, "parser.test.ts"), "import { parse } from \"./parser\";\n// a test will land here\n", "utf8");

  const stub = await startAnthropicStub();
  const configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-demo-config-"));
  const proc = spawnArchymedes({
    cwd: repo,
    cols: COLS,
    rows: ROWS,
    args: ["--currency", "USD", "--auto"],
    env: {
      ANTHROPIC_API_KEY: "sk-test-fake",
      ANTHROPIC_BASE_URL: stub.url,
      ARCHYMEDES_CONFIG_DIR: configDir,
      ARCHYMEDES_FX_OFFLINE: "true",
      TZ: "UTC",
    },
  });
  session.proc = proc;
  session.stub = stub;

  await proc.waitFor(PROMPT, { timeoutMs: 40_000 });

  // Frame 1: the prompt, with the task typed.
  proc.write("fix the failing test in parser.ts");
  await sleep(400);
  await writeFrame("1-prompt", styled(lastScreen(proc)));

  // The turn: a real edit (tool card renders in the transcript), then a passing check.
  stub.enqueue({
    kind: "tool_call",
    toolName: "write_file",
    input: { path: "parser.test.ts", content: 'import { parse } from "./parser";\nit("trims", () => { if (parse(" x ") !== "x") throw new Error("no trim"); });\n' },
  });
  stub.enqueue({ kind: "tool_call", toolName: "run_command", input: { command: "true" }, text: "Running the test." });
  stub.enqueue({ kind: "text", text: "The test now passes. **/diff** shows the change, **/undo** reverts it." });
  const mark = proc.output().length;
  proc.write("\r");
  await proc.waitFor(/turn complete|needs attention|verification/, { timeoutMs: 40_000, since: mark });
  await sleep(600);
  await writeFrame("2-turn", styled(lastScreen(proc)));

  // Frame 3: /diff output.
  const mark2 = proc.output().length;
  proc.write("/diff\r");
  await proc.waitFor(/parser\.test\.ts/, { timeoutMs: 20_000, since: mark2 });
  await sleep(500);
  await writeFrame("3-diff", styled(lastScreen(proc)));

  // Frame 4: /task — the review view the product is built around.
  const mark3 = proc.output().length;
  proc.write("/task\r");
  await proc.waitFor(/request|plan|verification|blockers|task/i, { timeoutMs: 20_000, since: mark3 });
  await sleep(500);
  await writeFrame("4-task", styled(lastScreen(proc)));

  proc.write("\x03");
  await proc.waitForExit(15_000).catch(() => proc.kill());
  await stub.close();
  await rm(repo, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  console.log(`frames written to ${OUT_DIR}`);
}

main().catch(async (error) => {
  session.proc?.kill();
  await session.stub?.close().catch(() => {});
  console.error(error);
  process.exit(1);
});
