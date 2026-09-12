import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAnthropicStub } from "../../packages/archymedes-cli/src/pty/anthropic-stub";

// The real CLI, isolated from project files and credentials, talking only to a local fixture.
const root = await mkdtemp(path.join(os.tmpdir(), "archymedes-workspace-preview-"));
const server = await startAnthropicStub();
for (let i = 0; i < 100; i++) server.enqueue({ kind: "text", text: [
  "This is the offline workspace preview. No model API was called and no project files were changed.",
  "",
  "Try **/mode** to choose a permission mode, **/models** to browse the model menu, or **Ctrl+G** to find an action.",
  "",
  "Page Up and Page Down explore the transcript. Escape returns to live output. **/layout** switches between the fixed workspace and terminal scrollback.",
].join("\n"), chunkSize: 10, chunkDelayMs: 25 });
const environment: Record<string, string> = {};
for (const name of ["PATH", "HOME", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "NO_COLOR", "ARCHYMEDES_NO_MOTION"]) {
  if (process.env[name] !== undefined) environment[name] = process.env[name]!;
}
try {
  const child = spawn(process.execPath, ["run", fileURLToPath(new URL("../../packages/archymedes-cli/src/archymedes.ts", import.meta.url)),
    "--layout", "fixed", "--provider", "anthropic", "--currency", "USD"], {
    cwd: root, stdio: "inherit", env: { ...environment, ANTHROPIC_API_KEY: "sk-test-preview", ANTHROPIC_BASE_URL: server.url,
      ARCHYMEDES_CONFIG_DIR: path.join(root, "config"), ARCHYMEDES_AUTO_UPDATE: "off", ARCHYMEDES_FX_OFFLINE: "true", TZ: "UTC" },
  });
  // The foreground process group delivers Ctrl+C to both processes; the CLI owns that interaction.
  const ignoreInterrupt = () => {};
  process.on("SIGINT", ignoreInterrupt);
  try { await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", () => resolve()); }); }
  finally { process.off("SIGINT", ignoreInterrupt); }
} finally {
  await server.close();
  await rm(root, { recursive: true, force: true });
}
