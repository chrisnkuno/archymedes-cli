/**
 * Whether this code is running from a published release bundle.
 *
 * `tooling/build/build-packages.ts` — the build that produces the npm package — replaces the
 * identifier below with `true` at bundle time. Every other way of running the CLI (`bun run agent`,
 * vitest, the local `build:cli`) leaves it undeclared, so the `typeof` guard reads `false` instead of
 * throwing. Security-relevant development escape hatches check this and stay shut in releases.
 */
declare const __FRIDAY_RELEASE_BUILD__: boolean | undefined;

export const RELEASE_BUILD: boolean = typeof __FRIDAY_RELEASE_BUILD__ === "boolean" ? __FRIDAY_RELEASE_BUILD__ : false;

/** `ARCHYMEDES_DEV=1` (or `true`) — the explicit opt-in for development-only behaviour. */
export function developmentFlag(environment: Record<string, string | undefined>): boolean {
  return /^(1|true)$/i.test(environment.ARCHYMEDES_DEV?.trim() ?? "");
}
