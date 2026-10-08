/**
 * The gateway's view of which free models are usable, refreshed from OpenRouter's public listing.
 *
 * One cache per process, shared by every request: the first call loads it, concurrent callers
 * share that single in-flight load, and once a list exists no request ever waits on OpenRouter
 * again. A stale list is served immediately while one background refresh replaces it
 * (stale-while-revalidate); a refresh failure keeps serving the last verified list and retries
 * after `retryMs` rather than on every request.
 */
import { fetchFreeCatalog } from "@archymedes/core/providers/free-catalog-fetch";
import { FREE_ROUTER, isFreeModelId, type FreeCatalog, type FreeModel } from "@archymedes/core/providers/free-catalog";

export const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000;

export function cachedEligibleModels(options: {
  load?: () => Promise<FreeCatalog>;
  ttlMs?: number;
  /** How long to keep serving the last list after a failed refresh before trying again. Default 60s. */
  retryMs?: number;
  now?: () => number;
} = {}): () => Promise<ReadonlyMap<string, FreeModel>> {
  const load = options.load ?? (() => fetchFreeCatalog({ discovery: false }));
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  const retryMs = Math.min(options.retryMs ?? 60_000, ttlMs);
  const now = options.now ?? Date.now;
  let current: { at: number; models: ReadonlyMap<string, FreeModel> } | undefined;
  let pending: Promise<ReadonlyMap<string, FreeModel>> | undefined;

  const refresh = () => {
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
        if (!current) throw error;
        // Keep the last verified list; look again after `retryMs`, not on the very next request.
        current = { at: now() - ttlMs + retryMs, models: current.models };
        return current.models;
      })
      .finally(() => { pending = undefined; });
    return pending;
  };

  return async () => {
    if (!current) return refresh();
    if (now() - current.at >= ttlMs) void refresh().catch(() => undefined);
    return current.models;
  };
}
