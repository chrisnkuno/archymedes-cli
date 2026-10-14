import { PROVIDER_IDS, PROVIDERS, catalogPrices, missingRequirements, providerEnvPrefix, type ProviderId } from "@archymedes/core/providers/agent-matrix";
import { isFreeModelId, isSmallModel } from "@archymedes/core/providers/free-catalog";
import { fetchableProviders, isCacheFresh, loadLiveModels, readModelCache, type FetchLike } from "@archymedes/core/providers/model-fetch";
import { describePrice, modelsForProvider } from "../session/models";

/**
 * `_archymedes/models` for a client that draws its own model picker: every model of every provider,
 * the ones it cannot use yet included, so the list is the whole menu and not only today's part.
 *
 * - The providers' own listings are asked whenever the cached ones are stale (opening the picker is
 *   the moment the list is wanted), or always with `refresh`. Providers with a key are asked, and
 *   so are the listings that need none — OpenRouter's, which carries every free model.
 * - A model of a provider with no key is `locked`, with what it is `missing`: shown, so someone can
 *   see what adding a key would give them, and not selectable until it is added.
 * - `free` marks a model that costs nothing: the free provider's, an OpenRouter `:free` id, or a
 *   zero rate card.
 *
 * `ARCHYMEDES_MODELS_OFFLINE=1` keeps it off the network unless asked to refresh, and never asks
 * the keyless listings.
 */

/** Providers whose model listing is public: asked even without a key. */
const PUBLIC_LISTINGS: readonly ProviderId[] = ["free", "openrouter"];

export async function modelList(
  environment: Record<string, string | undefined>,
  params: Record<string, unknown>,
  options: { fetchImpl?: FetchLike; now?: number } = {},
) {
  const offline = /^(1|true|on|yes)$/i.test(environment.ARCHYMEDES_MODELS_OFFLINE?.trim() ?? "");
  const cached = await readModelCache(environment);
  let live = isCacheFresh(cached, options.now) ? cached!.models : undefined;
  let errors: string[] = [];
  if (params.refresh === true || (!live && !offline)) {
    const asked = new Set<ProviderId>(fetchableProviders(environment, PROVIDER_IDS));
    if (!offline) for (const provider of PUBLIC_LISTINGS) asked.add(provider);
    const loaded = await loadLiveModels([...asked], environment, { refresh: true, ...options });
    if (Object.keys(loaded.models).length > 0) live = { ...(live ?? cached?.models ?? {}), ...loaded.models };
    errors = loaded.errors
      // Ollama needs no key, so it is always asked: a refusal is only news to someone who pointed
      // Archymedes at an Ollama server.
      .filter((error) => error.provider !== "ollama" || Boolean(environment.OLLAMA_BASE_URL?.trim()))
      .map((error) => `${error.provider}: ${error.error}`);
  }
  live ??= cached?.models;

  type Choice = {
    provider: ProviderId; providerLabel: string; model: string; isDefault: boolean; live: boolean;
    price: string; free: boolean; locked: boolean; missing: string[]; small: boolean;
  };
  const ready: Choice[] = [];
  const locked: Choice[] = [];
  const unconfigured: Array<{ provider: ProviderId; label: string; missing: string[] }> = [];
  // A free model is listed once, under the free provider (which holds it to a zero price), not
  // again among OpenRouter's whole catalog.
  const freeIds = new Set(live?.free ?? []);
  for (const provider of PROVIDER_IDS) {
    const spec = PROVIDERS[provider];
    const missing = missingRequirements(provider, environment);
    if (missing.length > 0) unconfigured.push({ provider, label: spec.label, missing });
    const known = modelsForProvider(provider);
    const knownSet = new Set(known);
    const extra = (live?.[provider] ?? [])
      .filter((model) => !knownSet.has(model) && (provider !== "free" || isFreeModelId(model)) && !(provider === "openrouter" && freeIds.has(model)))
      .sort();
    const preferred = environment[`${providerEnvPrefix(provider)}_MODEL`]?.trim() || spec.defaultModel;
    for (const model of [...known, ...extra]) {
      const prices = catalogPrices(provider, model);
      const free = provider === "free" || model.endsWith(":free") || Boolean(prices && prices.inputPerMillion === 0 && prices.outputPerMillion === 0);
      const choice: Choice = {
        provider, providerLabel: spec.label, model, isDefault: model === preferred, live: !knownSet.has(model),
        // Unconverted: the provider's own currency is the one its rate card is quoted in.
        price: free ? "free" : prices ? describePrice(prices, prices.currency, (value) => value) : "unpriced",
        free, locked: missing.length > 0, missing, small: isSmallModel(model),
      };
      (choice.locked ? locked : ready).push(choice);
    }
  }
  return { choices: [...ready, ...locked], unconfigured, errors, providers: PROVIDER_IDS.length };
}
