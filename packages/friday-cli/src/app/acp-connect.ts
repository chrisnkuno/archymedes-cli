import { providerEnvPrefix } from "@archymedes/core/providers/agent-matrix";
import { fetchProviderModels, readModelCache, writeModelCache, type FetchLike } from "@archymedes/core/providers/model-fetch";
import { checkOpenRouterKey, describeKeyCheckFailure, type KeyCheck } from "@archymedes/core/providers/openrouter-key-info";
import { isProviderId, missingRequirements, PROVIDER_INFO, type ProviderId } from "@archymedes/core/providers/provider-specs";
import {
  loadSettings, maskSetting, mergedEnvironment, saveSettings, SETTING_FIELDS, validateSetting,
  type ArchymedesSettings, type SettingKey,
} from "../platform/settings";

/**
 * Connecting a provider in one step, for a client that draws the form (the Go interface).
 *
 * The person fills in what the provider needs (its key, a base URL when it has one) and the agent
 * checks it the way that matters: by asking the provider for its models. A refused key is caught
 * before anything is saved; the models that come back are what the person picks from next, so
 * nobody types a model name or refreshes a list by hand.
 */

/** Where each provider is when no base URL is set: shown as the field's hint, never saved. */
const DEFAULT_BASE_URLS: Partial<Record<ProviderId, string>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
};

export type ProviderField = {
  key: SettingKey;
  label: string;
  kind: "secret" | "url" | "text";
  required: boolean;
  isSet: boolean;
  /** The current value, masked for a secret; empty when unset. */
  value: string;
  /** What applies when it is left empty (a default base URL), or an example. */
  placeholder?: string;
};

const fieldSpec = (key: string) => SETTING_FIELDS.find((field) => field.key === key);

/** The fields a provider is set up with: what it requires, then its base URL when it has one. */
export function providerFields(provider: ProviderId, environment: Record<string, string | undefined>): ProviderField[] {
  const required = PROVIDER_INFO[provider].requires;
  // The free provider goes through OpenRouter's fixed endpoint or a gateway: no base URL to offer.
  const baseUrl = provider === "free" ? undefined : `${providerEnvPrefix(provider)}_BASE_URL`;
  const keys = [...required, ...(baseUrl && !required.includes(baseUrl) && fieldSpec(baseUrl) ? [baseUrl] : [])];
  return keys.flatMap((key): ProviderField[] => {
    const spec = fieldSpec(key);
    if (!spec) return [];
    const secret = "secret" in spec && spec.secret === true;
    const url = "url" in spec && spec.url === true;
    const value = environment[key]?.trim() ?? "";
    const placeholder = url ? DEFAULT_BASE_URLS[provider] ?? "https://…/v1" : undefined;
    return [{
      key: spec.key,
      label: spec.label,
      kind: secret ? "secret" : url ? "url" : "text",
      required: required.includes(key),
      isSet: value !== "",
      value: secret && value ? maskSetting(value) : value,
      ...(placeholder ? { placeholder } : {}),
    }];
  });
}

export type ConnectResult =
  | { ok: true; file: string; models: string[]; note?: string }
  | { ok: false; error: string; field?: string };

export type ConnectDependencies = {
  /** The agent's live environment; updated in place so the switch that follows uses the new values. */
  environment: Record<string, string | undefined>;
  processEnvironment: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  checkOpenRouter?: (key: string) => Promise<KeyCheck>;
  load?: () => Promise<ArchymedesSettings>;
  save?: (settings: ArchymedesSettings) => Promise<string>;
};

const refused = (error: string | undefined) => /\b40[13]\b/.test(error ?? "");

/**
 * Validates what was filled in, checks it against the provider, saves it, and returns its models.
 *
 * An empty secret keeps the one already saved (the form shows it masked); an empty base URL goes
 * back to the provider's default. Nothing is saved when the provider refuses the key.
 */
export async function connectProvider(params: Record<string, unknown>, deps: ConnectDependencies): Promise<ConnectResult> {
  const provider = typeof params.provider === "string" ? params.provider : "";
  if (!isProviderId(provider)) return { ok: false, error: `Unknown provider "${provider}".` };
  const label = PROVIDER_INFO[provider].label;
  const values = (params.values && typeof params.values === "object" ? params.values : {}) as Record<string, unknown>;
  const fields = providerFields(provider, deps.environment);

  const current = await (deps.load ?? (() => loadSettings(deps.processEnvironment)))();
  const next: ArchymedesSettings = { ...current };
  for (const field of fields) {
    const raw = typeof values[field.key] === "string" ? (values[field.key] as string).trim() : undefined;
    if (raw === undefined || raw === "") {
      if (field.kind === "url" && raw === "") delete next[field.key];
      continue;
    }
    try {
      next[field.key] = validateSetting(field.key, raw);
    } catch (error) {
      return { ok: false, field: field.key, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const candidate = mergedEnvironment(next, deps.processEnvironment);
  const missing = missingRequirements(provider, candidate);
  if (missing.length > 0) return { ok: false, field: missing[0], error: `${label} still needs ${missing.join(" and ")}.` };

  const keyField = fields.find((field) => field.kind === "secret")?.key;
  let note: string | undefined;
  if ((provider === "free" || provider === "openrouter") && candidate.OPENROUTER_API_KEY) {
    // OpenRouter lists its models without a key, so the listing proves nothing: ask about the key.
    const check = await (deps.checkOpenRouter ?? ((value: string) => checkOpenRouterKey(value)))(candidate.OPENROUTER_API_KEY);
    if (!check.ok && check.reason === "invalid") return { ok: false, field: keyField, error: describeKeyCheckFailure(check) };
    if (!check.ok) note = `${describeKeyCheckFailure(check)} Saved anyway; the first request will confirm it.`;
  }

  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const listed = await fetchProviderModels(provider, candidate, fetchImpl, 8_000);
  if (listed.models.length === 0 && refused(listed.error)) {
    return { ok: false, field: keyField, error: `${label} refused the key (${listed.error}). Check it and paste it again.` };
  }
  if (listed.models.length === 0) {
    note = note ?? `Could not list ${label}'s models (${listed.error ?? "none returned"}). Saved; check the base URL if this persists.`;
  }

  const file = await (deps.save ?? ((value: ArchymedesSettings) => saveSettings(value, deps.processEnvironment)))(next);
  Object.assign(deps.environment, mergedEnvironment(next, deps.processEnvironment));
  if (listed.models.length > 0) await rememberModels(provider, listed.models, deps.environment);
  return { ok: true, file, models: listed.models, ...(note ? { note } : {}) };
}

/** The provider's models, asked of the provider now (not the cache), and remembered for the pickers. */
export async function providerModels(
  params: Record<string, unknown>,
  deps: { environment: Record<string, string | undefined>; fetchImpl?: FetchLike },
): Promise<{ models: string[]; error?: string }> {
  const provider = typeof params.provider === "string" ? params.provider : "";
  if (!isProviderId(provider)) return { models: [], error: `Unknown provider "${provider}".` };
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const listed = await fetchProviderModels(provider, deps.environment, fetchImpl, 8_000);
  if (listed.models.length > 0) await rememberModels(provider, listed.models, deps.environment);
  return { models: listed.models, ...(listed.error ? { error: listed.error } : {}) };
}

async function rememberModels(provider: ProviderId, models: string[], environment: Record<string, string | undefined>): Promise<void> {
  try {
    const cache = await readModelCache(environment);
    await writeModelCache(environment, {
      fetchedAt: cache?.fetchedAt ?? Date.now(),
      ...(cache?.freeCatalog ? { freeCatalog: cache.freeCatalog } : {}),
      models: { ...(cache?.models ?? {}), [provider]: models },
    });
  } catch { /* the pickers just ask again */ }
}

/**
 * Remembers the model picked for a provider (<PREFIX>_MODEL), so the next session on it starts there.
 * Optional: a provider whose model setting is not offered is simply not remembered.
 */
export async function rememberModel(
  params: Record<string, unknown>,
  deps: { environment: Record<string, string | undefined>; processEnvironment: Record<string, string | undefined>; load?: () => Promise<ArchymedesSettings>; save?: (settings: ArchymedesSettings) => Promise<string> },
): Promise<{ ok: boolean; error?: string }> {
  const provider = typeof params.provider === "string" ? params.provider : "";
  const model = typeof params.model === "string" ? params.model.trim() : "";
  if (!isProviderId(provider) || !model) return { ok: false, error: "A provider and a model are needed." };
  const key = `${providerEnvPrefix(provider)}_MODEL`;
  if (!fieldSpec(key)) return { ok: true };
  let value: string;
  try {
    value = validateSetting(key as SettingKey, model);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const current = await (deps.load ?? (() => loadSettings(deps.processEnvironment)))();
  const next: ArchymedesSettings = { ...current, [key]: value };
  await (deps.save ?? ((settings: ArchymedesSettings) => saveSettings(settings, deps.processEnvironment)))(next);
  Object.assign(deps.environment, mergedEnvironment(next, deps.processEnvironment));
  return { ok: true };
}
