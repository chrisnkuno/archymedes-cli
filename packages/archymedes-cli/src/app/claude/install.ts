import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION, managedSdkDirectory, sdkEntry } from "./sdk";

/**
 * Installs Anthropic's Claude Agent SDK into Archymedes's own folder, from npm, on this machine.
 *
 * Only the SDK's JavaScript: `--omit=optional` skips the Claude Code binary it can carry (about
 * 250 MB per platform), because the person's own installed `claude` is the one that runs, and
 * `--legacy-peer-deps` skips the peer packages only its custom-tool helpers need. What is left is
 * one package of about 5 MB that installs in under a second. `--ignore-scripts`: nothing runs.
 */

export type CommandRunner = (command: string, args: string[], options: { timeoutMs: number; env?: Record<string, string | undefined> }) => Promise<{ code: number | null; output: string }>;

export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    // npm is a .cmd script on Windows, which only a shell can start.
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true, ...(options.env ? { env: options.env } : {}) });
    let output = "";
    const keep = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-8_000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, output: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });

export type InstallResult = { ok: true; entry: string } | { ok: false; error: string };

export async function installSdk(environment: Record<string, string | undefined>, run: CommandRunner = runCommand): Promise<InstallResult> {
  const prefix = managedSdkDirectory(environment);
  await mkdir(prefix, { recursive: true });
  const { code, output } = await run("npm", [
    "install", "--prefix", prefix, "--omit=optional", "--legacy-peer-deps", "--ignore-scripts",
    "--no-audit", "--no-fund", "--loglevel=error", `${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION}`,
  ], { timeoutMs: 120_000 });
  if (code === 0) return { ok: true, entry: sdkEntry(prefix) };
  const reason = output.trim().split("\n").filter(Boolean).at(-1) ?? "npm did not start";
  return { ok: false, error: `Could not install ${CLAUDE_SDK_PACKAGE} (${reason}). Install it yourself with: npm install --prefix "${prefix}" --omit=optional --legacy-peer-deps ${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION}` };
}
