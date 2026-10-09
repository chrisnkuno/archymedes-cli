import { PROVIDER_IDS, PROVIDER_INFO, missingRequirements, providerEnvPrefix, type ProviderId } from "@archymedes/core/providers/agent-matrix";
import { freeAccess } from "@archymedes/core/providers/free-catalog";

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
  free: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  "archymedes-cloud": "",
  openrouter: "https://openrouter.ai/api/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
  "openai-compatible": "",
};

export function providerBaseUrl(environment: ProviderEnvironment, provider: ProviderId): string {
  if (provider === "free") {
    // Where free mode actually sends this session's requests, which is not always OpenRouter: with
    // no key of the user's own it goes to a gateway, and naming the wrong host is not cosmetic —
    // `--doctor` probes this URL, so it was reporting OpenRouter reachable for a session that only
    // ever talks to a gateway, and a failed turn told the user to check OpenRouter's status when
    // their own gateway was down.
    //
    // Derived from `freeAccess` rather than from a `_BASE_URL` variable, which is what keeps the
    // credential rule intact: a user's own key always resolves to the fixed OpenRouter host, so no
    // environment variable can point this at somewhere else while a key is set, and only the
    // keyless path yields a gateway — one `freeAccess` has already checked is https (or localhost
    // http) and carries no embedded credentials.
    const access = freeAccess(environment);
    return access && "gatewayUrl" in access ? `${access.gatewayUrl}/v1` : DEFAULT_BASE_URL.free;
  }
  const override = environment[`${providerEnvPrefix(provider)}_BASE_URL`]?.trim();
  return override || DEFAULT_BASE_URL[provider];
}

/** Every model provider's API endpoint, with the base-URL override applied when set. */
export function providerEndpoints(environment: ProviderEnvironment): ProviderEndpoint[] {
  return PROVIDER_IDS.map((id) => {
    return {
      id,
      label: PROVIDER_INFO[id].label,
      baseUrl: providerBaseUrl(environment, id),
      configured: missingRequirements(id, environment).length === 0,
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
