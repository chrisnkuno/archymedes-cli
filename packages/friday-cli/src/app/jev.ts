import type { ArchymedesAgentOptions } from "@archymedes/core/cli/agent";

/**
 * Jev (TypeSafe System One) configuration from the environment.
 *
 * On when a key is present, off otherwise — no key, no calls, no behavior change.
 * `ARCHYMEDES_JEV=off` forces off even with a key. The key itself is passed through
 * by reference, never logged: it lives in agent memory alone, alongside the provider
 * keys, and never reaches a session record, journal entry, or verdict payload.
 */
export function jevOptionsFromEnvironment(
  environment: Record<string, string | undefined>,
): ArchymedesAgentOptions["jev"] | undefined {
  if ((environment.ARCHYMEDES_JEV ?? "").trim().toLowerCase() === "off") return undefined;
  const apiKey = environment.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model = environment.TYPESAFE_MODEL?.trim();
  return { apiKey, ...(model ? { model } : {}), ...(environment.ARCHYMEDES_JEV_REVIEW?.trim().toLowerCase() === "off" ? { review: false } : {}) };
}
