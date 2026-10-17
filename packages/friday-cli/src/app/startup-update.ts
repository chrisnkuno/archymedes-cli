/**
 * One update round, before the first prompt and never again in this session.
 *
 * Here rather than on a timer, because this is the only moment that is unambiguously safe: no
 * turn is running, no job is attached, and nothing is half-written to the screen. The check
 * itself is bounded at three seconds, and every reason not to act — a pipe, CI, a session that
 * already looked today — is decided before the network is touched at all.
 *
 * Moved out of `main()` unchanged.
 */
import { spawn } from "node:child_process";
import type { Balance } from "@archymedes/core/cli/balance";
import { readAutoUpdateMode, runAutoUpdate } from "../platform/auto-update";
import { updateDefenderFeed } from "../platform/defender-feed-update";
import { ARCHYMEDES_CLI_VERSION, fetchLatestVersion, runSelfUpdate } from "../platform/update";
import type { Environment } from "./session-state";
import { liveTerminal, out, style } from "./transcript";

export async function runStartupUpdate(environment: Environment, interactive: boolean, currentBalance: () => Balance | undefined): Promise<void> {
  const [notice] = await Promise.all([startupMaintenance(environment, interactive && liveTerminal), Promise.resolve(currentBalance())]);
  for (const line of notice) out.write(`  ${style.dim(line)}\n`);
}

/**
 * The once-per-start upkeep — the defender feed refresh, and the daily update check and install —
 * returning what it has to say instead of printing it, so a client that draws its own screen (the
 * Go interface, through `_archymedes/startup`) can show it. Never throws: upkeep must not be the
 * reason a session fails to start.
 */
export async function startupMaintenance(
  environment: Environment,
  interactive: boolean,
  /** How to install an update; default: the self-updater in this process (which owns the terminal). */
  install?: (version: string) => Promise<boolean>,
): Promise<string[]> {
  // Knowledge replication is independent of package updates and model calls. It is deliberately
  // detached: an offline feed must add zero startup latency, and the last verified/bundled corpus
  // remains usable while this attempt completes in the background.
  void updateDefenderFeed(environment).catch(() => undefined);
  const run = await runAutoUpdate({
    context: {
      mode: readAutoUpdateMode(environment),
      interactive,
      environment,
      currentVersion: ARCHYMEDES_CLI_VERSION,
    },
    fetchLatest: (timeoutMs) => fetchLatestVersion({ environment, timeoutMs }),
    install: install ?? (async (version) => {
      const result = await runSelfUpdate({
        yes: true,
        interactive: false,
        environment,
        // Silent unless it has something to say: the outcome is reported through the notice, and a
        // package manager's own progress output has no business interrupting a prompt.
        stdout: () => {},
        stderr: () => {},
      });
      return result.status === "updated" && result.latestVersion === version;
    }),
  }).catch(() => undefined);
  return run?.notice ?? [];
}

/**
 * Installs an update from a separate `archymedes update --yes` process, for the ACP server: the
 * in-process updater runs the package manager synchronously with inherited stdio, which would block
 * every session on this connection and write npm's progress onto the protocol channel.
 */
export function installInChildProcess(entry: { execPath: string; script: string }, environment: Environment): (version: string) => Promise<boolean> {
  return (version) =>
    new Promise((resolve) => {
      const child = spawn(entry.execPath, [entry.script, "update", "--yes"], {
        env: { ...process.env, ...environment, NO_COLOR: "1" } as NodeJS.ProcessEnv,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0 && Boolean(version)));
    });
}
