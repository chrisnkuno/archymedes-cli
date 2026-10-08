import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The bun binary, as an absolute path a test can hand straight to `spawn`.
 *
 * Bare `"bun"` is not enough on two platforms. node-pty's macOS posix_spawnp binding does not
 * reliably search PATH. And on Windows an npm-installed bun puts only shims on PATH — `bun.cmd`
 * and `bun.ps1` — which Node refuses to spawn without a shell (`spawn bun ENOENT`, or `EINVAL` for
 * the `.cmd` since the 2024 batch-file fix). The real `bun.exe` sits beside those shims in
 * `node_modules/bun/bin`, so that is looked for before a shim is settled for.
 */
export function bunExecutable(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): string {
  const directories = (environment.PATH ?? environment.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  if (platform !== "win32") {
    for (const directory of directories) {
      const candidate = join(directory, "bun");
      if (exists(candidate)) return candidate;
    }
    return "bun";
  }
  for (const directory of directories) {
    const native = join(directory, "bun.exe");
    if (exists(native)) return native;
    const npmInstalled = join(directory, "node_modules", "bun", "bin", "bun.exe");
    if (exists(npmInstalled)) return npmInstalled;
  }
  for (const directory of directories) {
    const shim = join(directory, "bun.cmd");
    if (exists(shim)) return shim;
  }
  return "bun";
}
