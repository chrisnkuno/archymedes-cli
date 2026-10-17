/**
 * Models the providers themselves report, over and above the ones this build was compiled with.
 *
 * Held for the session (`SessionState.liveModels`) and filled on first use, so completion and the
 * picker widen without any of them paying for a request. A failure leaves it empty, which is
 * exactly the behaviour the CLI had before fetching existed.
 */
import { PROVIDER_IDS } from "@archymedes/core/providers/agent-matrix";
import { fetchableProviders, isCacheFresh, loadLiveModels, readModelCache } from "@archymedes/core/providers/model-fetch";
import type { Environment, SessionState } from "./session-state";

/**
 * Fills `liveModels`, from cache when it is fresh and from the providers otherwise.
 *
 * Never called at startup. A CLI that reaches the network before drawing its first prompt is a
 * CLI whose launch time depends on someone else's DNS, and the only thing the request buys is a
 * longer list in a menu that may never be opened. The cache is read at startup — that is free —
 * and the request happens the first time the list is actually wanted.
 */
export function createLiveModelRefresh(environment: Environment, state: Pick<SessionState, "liveModels">) {
  return async (options: { refresh?: boolean } = {}): Promise<{ errors: string[] }> => {
    const providers = fetchableProviders(environment, PROVIDER_IDS);
    if (providers.length === 0) return { errors: [] };
    const loaded = await loadLiveModels(providers, environment, options);
    if (Object.keys(loaded.models).length > 0) state.liveModels = loaded.models;
    return {
      errors: loaded.errors
        // Ollama needs no key, so it is always "configured" and is always asked — a free probe of
        // localhost that costs nothing when nothing is listening. Reporting that refusal is a
        // different matter: to everyone not running Ollama it is a warning about a provider they
        // have never heard of, printed every time they ask to see the model list. It is only worth
        // saying when they pointed Archymedes at an Ollama server and it did not answer.
        .filter((error) => error.provider !== "ollama" || Boolean(environment.OLLAMA_BASE_URL?.trim()))
        .map((error) => `${error.provider}: ${error.error}`),
    };
  };
}

/** Free: a cache hit widens completion and the picker with no request at all. A miss simply means the first `/models` pays for the fetch. */
export async function readCachedLiveModels(environment: Environment, state: Pick<SessionState, "liveModels">): Promise<void> {
  const cached = await readModelCache(environment);
  if (isCacheFresh(cached)) state.liveModels = cached!.models;
}
