/**
 * The gateway's view of which free models are usable, refreshed from OpenRouter's public listing.
 * A refresh failure keeps serving the last verified list rather than taking free mode down, and
 * concurrent requests share one in-flight refresh instead of each hitting OpenRouter.
 */
import { fetchFreeCatalog } from "@archymedes/core/providers/free-catalog-fetch";
import { FREE_ROUTER, isFreeModelId, type FreeCatalog, type FreeModel } from "@archymedes/core/providers/free-catalog";

export function cachedEligibleModels(options: {
  load?: () => Promise<FreeCatalog>;
  ttlMs?: number;
  now?: () => number;
} = {}): () => Promise<ReadonlyMap<string, FreeModel>> {
  const load = options.load ?? (() => fetchFreeCatalog({ discovery: false }));
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  let current: { at: number; models: ReadonlyMap<string, FreeModel> } | undefined;
  let pending: Promise<ReadonlyMap<string, FreeModel>> | undefined;

  return async () => {
    if (current && now() - current.at < ttlMs) return current.models;
    pending ??= load()
      .then((catalog) => {
        const models = new Map(catalog.models
          .filter((model) => model.eligible && model.id !== FREE_ROUTER && isFreeModelId(model.id))
          .map((model) => [model.id, model]));
        if (models.size === 0) throw new Error("No eligible free models");
        current = { at: now(), models };
        return models as ReadonlyMap<string, FreeModel>;
      })
      .catch((error) => {
        if (current) return current.models;
        throw error;
      })
      .finally(() => { pending = undefined; });
    return pending;
  };
}
