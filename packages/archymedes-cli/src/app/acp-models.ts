import { PROVIDER_IDS } from "@archymedes/core/providers/agent-matrix";
import { buildModelCatalog, describePrice } from "../session/models";
import { createLiveModelRefresh, readCachedLiveModels } from "./live-models";

/**
 * `_archymedes/models` for a client that draws its own model picker: what this agent can switch to,
 * with the price of each in the provider's own currency, and which providers are missing a key.
 *
 * The same catalog as `/models` in the terminal (`buildModelCatalog`), including the models a
 * provider reported live; `refresh` asks the providers again rather than reading the cache.
 */
export async function modelList(environment: Record<string, string | undefined>, params: Record<string, unknown>) {
  const state: { liveModels?: Parameters<typeof buildModelCatalog>[2] } = {};
  let errors: string[] = [];
  if (params.refresh === true) errors = (await createLiveModelRefresh(environment, state as never)({ refresh: true })).errors;
  else await readCachedLiveModels(environment, state as never);
  const catalog = buildModelCatalog(environment, undefined, state.liveModels);
  return {
    choices: catalog.choices.map((choice) => ({
      provider: choice.provider,
      providerLabel: choice.providerLabel,
      model: choice.model,
      isDefault: choice.isProviderDefault,
      live: Boolean(choice.live),
      // Unconverted: the provider's own currency is the one its rate card is quoted in.
      price: choice.prices ? describePrice(choice.prices, choice.prices.currency, (value) => value) : "unpriced",
    })),
    unconfigured: catalog.unconfigured.map(({ provider, label, missing }) => ({ provider, label, missing })),
    errors,
    providers: PROVIDER_IDS.length,
  };
}
