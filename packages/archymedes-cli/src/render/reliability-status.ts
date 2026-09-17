import bundledEvidence from "../../../../reliability/latest.json";
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

export const BUNDLED_RELIABILITY = bundledEvidence as ReliabilitySnapshot;

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
