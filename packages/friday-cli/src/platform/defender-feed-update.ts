/** Non-blocking CLI scheduler for the central Defensive Brain feed. */
import { refreshDefenderFeed, type DefenderFeedResult } from "@archymedes/core/cli/defender-feed";
import { developmentFlag, RELEASE_BUILD } from "./build-flavor";

export const OFFICIAL_DEFENDER_FEED_URL = "https://circuit-archymedes.vercel.app/api/defender-brain/manifest";

/**
 * Release keys are intentionally a map: adding a successor before retiring its predecessor makes
 * key rotation possible without an update outage. The official authority is rooted here rather than
 * in the network or the environment.
 */
export const OFFICIAL_DEFENDER_FEED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "release-2026-01": "MCowBQYDK2VwAyEA4/jb1zd6f+jIPAFja1bPNtroXV8MtAZFrKt5BSY+ngI=",
});

export type DefenderFeedKeyPolicy = { releaseBuild?: boolean };

/**
 * The keys a feed manifest may be signed by.
 *
 * `ARCHYMEDES_DEFENDER_BRAIN_PUBLIC_KEYS` exists for staging feeds, and it is deliberately narrow:
 * it is read only when `ARCHYMEDES_DEV=1` is set *and* this is not a release build, and even then it
 * can only add keys under new ids. An environment variable is not an authority — anything able to
 * set one (a dotfile, a CI secret, a malicious `.envrc`) must not be able to swap the root of trust
 * and get a poisoned corpus accepted as official.
 */
export function defenderFeedKeys(environment: Record<string, string | undefined>, policy: DefenderFeedKeyPolicy = {}): Readonly<Record<string, string>> {
  if (policy.releaseBuild ?? RELEASE_BUILD) return OFFICIAL_DEFENDER_FEED_KEYS;
  if (!developmentFlag(environment)) return OFFICIAL_DEFENDER_FEED_KEYS;
  const configured = environment.ARCHYMEDES_DEFENDER_BRAIN_PUBLIC_KEYS?.trim();
  if (!configured) return OFFICIAL_DEFENDER_FEED_KEYS;
  let parsed: unknown;
  try { parsed = JSON.parse(configured); } catch { return OFFICIAL_DEFENDER_FEED_KEYS; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return OFFICIAL_DEFENDER_FEED_KEYS;
  const additions = Object.entries(parsed).filter(([id, key]) =>
    /^[a-zA-Z0-9._-]{1,64}$/.test(id) && typeof key === "string" && key.length <= 4_096 && !Object.hasOwn(OFFICIAL_DEFENDER_FEED_KEYS, id));
  // Official entries are spread last so no id collision can ever displace them.
  return Object.freeze({ ...Object.fromEntries(additions), ...OFFICIAL_DEFENDER_FEED_KEYS });
}

export async function updateDefenderFeed(
  environment: Record<string, string | undefined>,
  options: DefenderFeedKeyPolicy & { fetch?: Parameters<typeof refreshDefenderFeed>[0]["fetch"]; now?: number; force?: boolean } = {},
): Promise<DefenderFeedResult> {
  const keys = defenderFeedKeys(environment, options);
  return refreshDefenderFeed({
    environment: { ...environment, ARCHYMEDES_DEFENDER_FEED_URL: environment.ARCHYMEDES_DEFENDER_FEED_URL?.trim() || OFFICIAL_DEFENDER_FEED_URL },
    keys,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.force ? { force: true } : {}),
  });
}
