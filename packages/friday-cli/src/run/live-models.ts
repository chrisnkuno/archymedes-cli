import { isCacheFresh, readModelCache } from "@archymedes/core/providers/model-fetch";
import type { SessionState } from "./session-state";
import type { Environment } from "../platform/environment";

/** Free: a cache hit widens completion and the picker with no request at all. A miss simply means the first `/models` pays for the fetch. */
export async function readCachedLiveModels(environment: Environment, state: Pick<SessionState, "liveModels">): Promise<void> {
  const cached = await readModelCache(environment);
  if (isCacheFresh(cached)) state.liveModels = cached!.models;
}
