import { PROVIDER_IDS, PROVIDER_INFO, providerEnvPrefix, type ProviderId } from "@archymedes/core/providers/agent-matrix";

/**
 * The network endpoints Archymedes depends on, in one place.
 *
 * The CLI has exactly three network dependencies: the model API that does the work (required),
 * the daily FX-rate lookup that prices it in local currency (optional, skipped by ARCHYMEDES_FX_OFFLINE
 * or a configured rate), and the npm registry that self-update checks (optional, only reached on
 * `archymedes update`). Keeping them here means the connectivity doctor, the FX lookup and the update
 * check all agree on what to call — a doctor that says an endpoint is fine while the same lookup
 * times out would be its own kind of unprofessional.
 */

export const FX_ENDPOINTS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies",
  "https://latest.currency-api.pages.dev/v1/currencies",
] as const;

export const DEFAULT_UPDATE_REGISTRY = "https://registry.npmjs.org";

export type ProviderEnvironment = Record<string, string | undefined>;

export type ProviderEndpoint = {
  id: ProviderId;
  /** Human label, e.g. "OpenAI". */
  label: string;
  baseUrl: string;
  /** Credentials for this provider are present, so the CLI can actually use it. */
  configured: boolean;
};

/** The default API host for each provider, before any `<PROVIDER>_BASE_URL` override. */
const DEFAULT_BASE_URL: Record<ProviderId, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
  "openai-compatible": "",
};

export function providerBaseUrl(environment: ProviderEnvironment, provider: ProviderId): string {
  const override = environment[`${providerEnvPrefix(provider)}_BASE_URL`]?.trim();
  return override || DEFAULT_BASE_URL[provider];
}

/** The single API-key variable a provider needs, or "" for one (Ollama) that needs none. */
function providerKeyName(provider: ProviderId): string {
  return PROVIDER_INFO[provider].requires.find((name) => name.endsWith("_API_KEY")) ?? "";
}

/** Every model provider's API endpoint, with the base-URL override applied when set. */
export function providerEndpoints(environment: ProviderEnvironment): ProviderEndpoint[] {
  return PROVIDER_IDS.map((id) => {
    const keyName = providerKeyName(id);
    return {
      id,
      label: PROVIDER_INFO[id].label,
      baseUrl: providerBaseUrl(environment, id),
      configured: keyName === "" ? true : Boolean(environment[keyName]?.trim()),
    };
  });
}

/** The host part of a URL, for error messages that should name what failed. */
export function hostOf(url: string | URL): string {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}
