/**
 * Free-model catalog policy: parses ClawLabsAI discovery data and OpenRouter's live listing, and
 * decides which models free mode may select. Discovery claims never make a model eligible; only
 * OpenRouter's own zero prices, text output and tool support do, and missing metadata fails closed.
 */
/** Free-model discovery is data, not authority to call an arbitrary endpoint or spend money. */
export const FREE_ROUTER = "openrouter/free";
export const FREE_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * The official hosted free gateway (`packages/free-gateway`). Empty until it is deployed: shipping a
 * URL nobody operates would make `--free` fail for everyone with a network error instead of a clear
 * setup message. `ARCHYMEDES_FREE_GATEWAY_URL` points at a staging or self-hosted gateway.
 */
export const FREE_GATEWAY_URL = "";
export const FREE_DISCOVERY_URL = "https://raw.githubusercontent.com/ClawLabsAI/free-ai-models/main/data/models.json";
export const FREE_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const FREE_CATALOG_MAX_RECORDS = 10_000;
/**
 * Order the free router tries verified candidates in. Probed 2026-09-15 with a real tool call:
 * these answered with a structured call quickly. Largest-context-first chose gated (403 outside
 * listed apps) and very slow models. Ordering only; eligibility still comes from the live listing,
 * and unlisted eligible models follow by context size.
 */
export const FREE_ROUTER_PREFERENCE: readonly string[] = [
  "cohere/north-mini-code:free",
  "google/gemma-4-31b-it:free",
  "dots-studio/dots-3-note-preview:free",
  "nex-agi/nex-n2.5-pro:free",
  "nvidia/nemotron-3.5-lightning:free",
  "google/gemma-4-26b-a4b-it:free",
  "inclusionai/ling-3.0-flash-vl:free",
  "poolside/laguna-xs-2.1:free",
];

export type FreeModel = {
  id: string;
  name: string;
  provider: string;
  context_window: number | null;
  max_output: number | null;
  modalities: string[];
  rate_limit: string;
  source: string;
  eligible: boolean;
  reason?: string;
  /** Original third-party claims, kept separate from verified OpenRouter facts. */
  discovery?: Omit<FreeModel, "eligible" | "reason" | "discovery">;
};

/** How free mode reaches models: the user's own key goes direct; otherwise a gateway that holds one. */
export type FreeAccess = { apiKey: string } | { gatewayUrl: string };

function gatewayUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value?.trim() ?? "");
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && local))) return undefined;
    return url.href.replace(/\/+$/, "");
  } catch { return undefined; }
}

export function freeAccess(environment: Record<string, string | undefined>): FreeAccess | undefined {
  const apiKey = environment.OPENROUTER_API_KEY?.trim();
  if (apiKey) return { apiKey };
  const configured = environment.ARCHYMEDES_FREE_GATEWAY_URL?.trim();
  const url = configured ? gatewayUrl(configured) : gatewayUrl(FREE_GATEWAY_URL);
  return url ? { gatewayUrl: url } : undefined;
}

export type FreeCatalog = { fetchedAt: number; models: FreeModel[]; warnings: string[] };

export function isFreeModelId(id: string): boolean {
  return id === FREE_ROUTER || (id.length <= 256 && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i.test(id));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function label(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 512) : fallback;
}

function limit(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => label(item)))].slice(0, 64) : [];
}

function entries(body: unknown, key: string): unknown[] {
  const items = record(body)[key];
  if (!Array.isArray(items) || items.length > FREE_CATALOG_MAX_RECORDS) throw new Error("Invalid or oversized free model catalog");
  return items;
}

function sourceUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password && ["openrouter.ai", "pollinations.ai"].includes(url.hostname)
      ? url.href : undefined;
  } catch { return undefined; }
}

/** Invalid and duplicate records cannot win over another source's facts. */
export function parseFreeDiscovery(body: unknown): FreeModel[] {
  const models = new Map<string, FreeModel>();
  const duplicates = new Set<string>();
  for (const item of entries(body, "models")) {
    const row = record(item);
    const id = label(row.id);
    const source = sourceUrl(row.source);
    if (!id || !source || !/^[a-z0-9._:/-]+$/i.test(id)) continue;
    if (models.has(id)) duplicates.add(id);
    models.set(id, {
      id, name: label(row.name, id), provider: label(row.provider, "Unknown"),
      context_window: limit(row.context_window), max_output: limit(row.max_output),
      modalities: strings(row.modalities), rate_limit: label(row.rate_limit, "unknown"), source,
      eligible: false, reason: "Not verified as a free OpenRouter tool model",
    });
  }
  return [...models.values()].filter((model) => !duplicates.has(model.id));
}

/** Only explicitly zero-priced, text-producing tool models qualify. Missing metadata fails closed. */
export function parseFreeOpenRouterModels(body: unknown): FreeModel[] {
  const models = new Map<string, FreeModel>();
  const duplicates = new Set<string>();
  for (const item of entries(body, "data")) {
    const row = record(item);
    if (typeof row.id !== "string" || !isFreeModelId(row.id)) continue;
    const id = row.id;
    const pricing = record(row.pricing);
    const zero = (value: unknown) => (typeof value === "number" || (typeof value === "string" && /^0(?:\.0+)?$/.test(value))) && Number(value) === 0;
    const architecture = record(row.architecture);
    const top = record(row.top_provider);
    const context = limit(row.context_length);
    const output = limit(top.max_completion_tokens);
    const reason = !zero(pricing.prompt) || !zero(pricing.completion) || (pricing.request !== undefined && !zero(pricing.request))
      ? "Zero pricing not confirmed"
      : !strings(architecture.output_modalities).includes("text") ? "No text output"
      : !strings(row.supported_parameters).includes("tools") ? "Tool calling not confirmed"
      : !context ? "Context limit unknown" : undefined;
    if (models.has(id)) duplicates.add(id);
    models.set(id, {
      id, name: label(row.name, id), provider: id.split("/")[0], context_window: context,
      max_output: output, modalities: strings(architecture.input_modalities),
      rate_limit: "OpenRouter account quotas apply", source: `https://openrouter.ai/${id}`,
      eligible: !reason, ...(reason ? { reason } : {}),
    });
  }
  return [...models.values()].filter((model) => !duplicates.has(model.id));
}

export function mergeFreeCatalog(live: FreeModel[], discovery: FreeModel[], fetchedAt: number, warnings: string[] = []): FreeCatalog {
  const byId = new Map(discovery.map((model) => [model.id, model]));
  for (const model of live) {
    const claimed = byId.get(model.id);
    if (claimed) {
      const { eligible: _eligible, reason: _reason, discovery: _discovery, ...metadata } = claimed;
      byId.set(model.id, { ...model, discovery: metadata });
    } else byId.set(model.id, model);
  }
  return { fetchedAt, models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), warnings };
}
