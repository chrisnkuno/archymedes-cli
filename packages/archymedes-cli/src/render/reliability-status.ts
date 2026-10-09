import { isProviderId } from "@archymedes/core/providers/provider-specs";
import { clipTo } from "../text/text-width";

export type ReliabilitySnapshot = {
  score: number;
  grade: string;
  generatedAt: string;
  /** What the score was measured on; a score says nothing about a model this build cannot run. */
  provider?: string;
  model?: string;
};

/**
 * The measurement this build ships with: none.
 *
 * `reliability/latest.json` used to be imported here. It scored `circuitnotion`, a provider this
 * build no longer has, so `renderReliabilityStatus` already refused to print it — leaving a
 * 91/100 in the tree that nothing could display and nothing could regenerate, since no script
 * writes this artifact. A dated score for a model the user cannot run is worse than no score, so
 * the file is gone and the absence is stated here instead of implied by a filter.
 *
 * To ship one again: measure a *shipped* provider with `scoreReliability`
 * (`@archymedes/core/cli/reliability`), put the report back under `reliability/`, and import it
 * here. The guard in `renderReliabilityStatus` stays either way — it is what stops a future
 * measurement on a since-removed provider from being shown at startup.
 */
export const BUNDLED_RELIABILITY: ReliabilitySnapshot = { score: NaN, grade: "unmeasured", generatedAt: "" };

/**
 * A release-baked trust signal: instant and offline, with a date so it can never pose as live data.
 * Empty when the measurement was taken on a provider this build does not ship: the bundled report
 * once scored a since-removed provider, and showing that number at every startup implied the tool
 * the user was running had earned it.
 */
export function renderReliabilityStatus(
  width: number,
  separator: string,
  snapshot: ReliabilitySnapshot = BUNDLED_RELIABILITY,
): string {
  if (!snapshot.provider || !isProviderId(snapshot.provider)) return "";
  const date =
    /^\d{4}-\d{2}-\d{2}/.exec(snapshot.generatedAt)?.[0] ?? "unknown date";
  const score = Number.isFinite(snapshot.score)
    ? `${Math.max(0, Math.min(100, Math.round(snapshot.score)))}/100` : "unavailable";
  // Bundled evidence is a historical benchmark, not a live service-health measurement.
  const text = width < 48
    ? `benchmark ${score} ${separator} ${date}`
    : `bundled benchmark ${score}${snapshot.model ? ` on ${snapshot.model}` : ""} ${separator} measured ${date}`;
  return clipTo(text, Math.max(0, width));
}
