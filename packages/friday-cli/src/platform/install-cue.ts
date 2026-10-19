import { promises as fs } from "node:fs";
import path from "node:path";
import type { Environment } from "./environment";
import { settingsDirectory } from "./settings";
import { ARCHYMEDES_CLI_VERSION } from "./update";

/**
 * One anonymous cue when a new version first runs, so installs and updates can be counted
 * (archymedes.xyz, `/api/v1/count`; the site's lib/counter.ts keeps the count honest).
 *
 * Sent on first run rather than from an npm `postinstall`: install scripts are skipped by
 * `--ignore-scripts`, pnpm and bun, and a package that phones home while installing is what
 * supply-chain scanners flag. First run also tells an update from an install, which npm's own
 * download numbers cannot.
 *
 * What is sent is `{ event, version, os, arch }` and nothing else: no id, no path, no project, no
 * account. Off with `ARCHYMEDES_TELEMETRY=off` (also in Settings) or `DO_NOT_TRACK=1`, and never
 * from CI or a test run. It never delays anything: the caller does not await it, the request gives
 * up after two seconds, and a failure is silent and retried on the next run.
 */

export const INSTALL_CUE_URL = "https://archymedes.xyz/api/v1/count/";
const MARKER = "installed.json";
const TIMEOUT_MS = 2_000;

export type InstallCue = { event: "install" | "update"; version: string; os: string; arch: string };

/** Whether the person (or the place it runs) said no. */
export function cueOptedOut(environment: Environment): boolean {
  const telemetry = environment.ARCHYMEDES_TELEMETRY?.trim().toLowerCase();
  if (telemetry && ["off", "0", "false", "no"].includes(telemetry)) return true;
  const doNotTrack = environment.DO_NOT_TRACK?.trim();
  if (doNotTrack && doNotTrack !== "0" && doNotTrack.toLowerCase() !== "false") return true;
  // A CI machine reinstalls on every run, and a test run is not a person installing.
  return Boolean(environment.CI?.trim()) || environment.NODE_ENV === "test";
}

/** The cue this run owes, given the version the last cue was for; undefined when it owes none. */
export function cueFor(lastVersion: string | undefined, version: string, os: string, arch: string): InstallCue | undefined {
  if (lastVersion === version) return undefined;
  return { event: lastVersion ? "update" : "install", version, os, arch };
}

export type CueDependencies = {
  fetch: typeof fetch;
  readMarker(): Promise<string | undefined>;
  writeMarker(version: string): Promise<void>;
};

export type CueOutcome = "sent" | "owed-none" | "opted-out" | "failed";

/**
 * Sends the cue this run owes. The marker is written once the counter answered: any 2xx, or a 4xx
 * (refused for good, so retrying cannot help). No answer or a 5xx leaves it for the next run.
 */
export async function sendInstallCue(environment: Environment, dependencies: CueDependencies = fileDependencies(environment), version = ARCHYMEDES_CLI_VERSION): Promise<CueOutcome> {
  if (cueOptedOut(environment)) return "opted-out";
  const cue = cueFor(await dependencies.readMarker(), version, process.platform, process.arch);
  if (!cue) return "owed-none";
  try {
    const response = await dependencies.fetch(environment.ARCHYMEDES_TELEMETRY_URL?.trim() || INSTALL_CUE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cue),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status >= 500) return "failed";
    await dependencies.writeMarker(version);
    return "sent";
  } catch {
    return "failed";
  }
}

/** The marker beside settings.json: the version the last cue was for. */
function fileDependencies(environment: Environment): CueDependencies {
  const file = path.join(settingsDirectory(environment), MARKER);
  return {
    fetch,
    readMarker: async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" ? parsed.version : undefined;
      } catch {
        return undefined;
      }
    },
    writeMarker: async (version) => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, `${JSON.stringify({ version })}\n`, { mode: 0o600 });
    },
  };
}
