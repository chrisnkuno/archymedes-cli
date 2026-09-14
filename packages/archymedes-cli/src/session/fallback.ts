import { PROVIDER_IDS, isProviderId, type ProviderId } from "@archymedes/core/providers/agent-matrix";

export type FallbackPreference =
  | { kind: "off" }
  | { kind: "ask" }
  | { kind: "target"; provider: ProviderId; model: string };

/** The provider ids a fallback target may name, for help text and validators. */
export const FALLBACK_PROVIDERS: readonly ProviderId[] = PROVIDER_IDS;

export function parseFallbackPreference(raw: string | undefined): FallbackPreference | null {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === "off") return { kind: "off" };
  if (value.toLowerCase() === "ask") return { kind: "ask" };
  const match = /^([a-z-]+)[:/]([^\s]+)$/i.exec(value);
  if (!match) return null;
  const provider = match[1].toLowerCase();
  if (!isProviderId(provider)) return null;
  return { kind: "target", provider, model: match[2] };
}

export function fallbackSetting(preference: FallbackPreference): string | undefined {
  if (preference.kind === "off") return undefined;
  if (preference.kind === "ask") return "ask";
  return `${preference.provider}:${preference.model}`;
}
