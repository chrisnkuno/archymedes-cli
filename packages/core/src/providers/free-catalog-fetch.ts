/**
 * Fetches the public free-model listings with a timeout, a byte cap and no redirects. It never sees
 * a credential, so catalog data cannot steer the OpenRouter key elsewhere; `modelsUrl` only chooses
 * which public listing (OpenRouter's or a free gateway's) is read.
 * A failed discovery fetch degrades to verified OpenRouter metadata instead of failing the refresh.
 */
import { FREE_BASE_URL, FREE_DISCOVERY_URL, mergeFreeCatalog, parseFreeDiscovery, parseFreeOpenRouterModels, type FreeCatalog } from "./free-catalog";

/** Fetches public metadata only. No credentials enter this module. */
export type FreeCatalogFetch = (url: string, init?: { signal?: AbortSignal; redirect?: RequestRedirect; headers?: Record<string, string> }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>;
  body?: ReadableStream<Uint8Array> | null;
}>;

const MAX_BYTES = 8 * 1024 * 1024;

async function boundedJson(fetchImpl: FreeCatalogFetch, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, { signal, redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Catalog returned HTTP ${response.status}`);
  if (!response.body) {
    const result = await response.json();
    if (JSON.stringify(result).length > MAX_BYTES) throw new Error("Catalog exceeds size limit");
    return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) throw new Error("Catalog exceeds size limit");
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function fetchFreeCatalog(options: {
  fetchImpl?: FreeCatalogFetch; signal?: AbortSignal; timeoutMs?: number; now?: number; discovery?: boolean; modelsUrl?: string;
} = {}): Promise<FreeCatalog> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 15_000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const warnings: string[] = [];
  const work = Promise.all([
    boundedJson(fetchImpl, options.modelsUrl ?? `${FREE_BASE_URL}/models`, signal).then(parseFreeOpenRouterModels),
    options.discovery === false ? [] : boundedJson(fetchImpl, FREE_DISCOVERY_URL, signal).then(parseFreeDiscovery).catch(() => {
      warnings.push("ClawLabsAI discovery unavailable; showing verified OpenRouter metadata only");
      return [];
    }),
  ]);
  let onAbort: () => void = () => undefined;
  try {
    const [live, discovery] = await Promise.race([work, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
    signal.throwIfAborted();
    return mergeFreeCatalog(live, discovery, options.now ?? Date.now(), warnings);
  } finally { signal.removeEventListener("abort", onAbort); }
}
