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
import type { Balance } from "@archymedes/core/cli/balance";
import { readAutoUpdateMode, runAutoUpdate } from "../platform/auto-update";
import { updateDefenderFeed } from "../platform/defender-feed-update";
import { ARCHYMEDES_CLI_VERSION, fetchLatestVersion, runSelfUpdate } from "../platform/update";
import type { Environment } from "./session-state";
import { liveTerminal, out, style } from "./transcript";

export async function runStartupUpdate(environment: Environment, interactive: boolean, currentBalance: () => Balance | undefined): Promise<void> {
  const startupBalance: Promise<Balance | undefined> = Promise.resolve(currentBalance());
  // Knowledge replication is independent of package updates and model calls. It is deliberately
  // detached: an offline feed must add zero startup latency, and the last verified/bundled corpus
  // remains usable while this attempt completes in the background.
  void updateDefenderFeed(environment).catch(() => undefined);
  const startupUpdatePromise = runAutoUpdate({
    context: {
      mode: readAutoUpdateMode(environment),
      interactive: interactive && liveTerminal,
      environment,
      currentVersion: ARCHYMEDES_CLI_VERSION,
    },
    fetchLatest: (timeoutMs) => fetchLatestVersion({ environment, timeoutMs }),
    install: async (version) => {
      const result = await runSelfUpdate({
        yes: true,
        interactive: false,
        environment,
        // Silent unless it has something to say: the outcome is reported through the notice below,
        // and a package manager's own progress output has no business interrupting a prompt.
        stdout: () => {},
        stderr: () => {},
      });
      return result.status === "updated" && result.latestVersion === version;
    },
  }).catch(() => {
    // An update check must never be the reason a session fails to start.
    return undefined;
  });
  const [startupUpdate] = await Promise.all([startupUpdatePromise, startupBalance]);
  for (const line of startupUpdate?.notice ?? []) out.write(`  ${style.dim(line)}\n`);
}
