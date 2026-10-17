import { PROVIDER_INFO, PROVIDER_IDS, isProviderId, missingRequirements, type ProviderId } from "@archymedes/core/providers/provider-specs";
import { providerEnvPrefix, resolveProvider } from "@archymedes/core/providers/agent-matrix";
import { checkOpenRouterKey, describeKeyCheckFailure, type KeyCheck } from "@archymedes/core/providers/openrouter-key-info";
import { OPENROUTER_KEYS_URL } from "./free-setup";
import { providerFields, type ProviderField } from "./acp-connect";
import { loadSettings, mergedEnvironment, saveSettings, SETTING_FIELDS, validateSetting, type ArchymedesSettings, type SettingKey } from "../platform/settings";

/**
 * First-run setup for a client that draws its own screens (the Go interface), over ACP.
 *
 * The terminal CLI asks for a key in its own prompt (`runFreeModeSetup`); a client that owns the
 * screen cannot share that prompt, so it asks the same two questions through the protocol instead:
 * `_archymedes/setup/status` (is a provider usable, and which could be set up with one key) and
 * `_archymedes/setup/save` (check this key, save it, and use it from the next `session/new`).
 * Saving goes through the same settings file and validation as `archymedes settings`.
 */

/** Where each key-only provider hands out keys, so the client can say where to get one. */
const KEY_URLS: Partial<Record<ProviderId, string>> = {
  free: OPENROUTER_KEYS_URL,
  openrouter: OPENROUTER_KEYS_URL,
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/apikey",
  xai: "https://console.x.ai",
  deepseek: "https://platform.deepseek.com/api_keys",
  mistral: "https://console.mistral.ai/api-keys",
  groq: "https://console.groq.com/keys",
};

export type SetupProvider = {
  id: ProviderId;
  label: string;
  /** The one variable a key fills; absent for providers that need more than a key (set up with `archymedes settings`). */
  keyVariable?: string;
  keyUrl?: string;
  configured: boolean;
};

export type SetupStatus = { configured: boolean; reason?: string; providers: SetupProvider[] };

/** Free first: it is the provider someone with no account can use. */
const ORDER: ProviderId[] = ["free", ...PROVIDER_IDS.filter((id) => id !== "free")];

/** `requested` is the provider and model the command line asked for, judged as session/new will judge them. */
export function setupStatus(environment: Record<string, string | undefined>, requested: { provider?: string; model?: string } = {}): SetupStatus {
  const resolved = resolveProvider(environment, requested);
  const providers = ORDER.map((id): SetupProvider => {
    const info = PROVIDER_INFO[id];
    const keyOnly = info.requires.length === 1 && SETTING_FIELDS.some((field) => field.key === info.requires[0]);
    return {
      id,
      label: info.label,
      ...(keyOnly ? { keyVariable: info.requires[0] } : {}),
      ...(KEY_URLS[id] ? { keyUrl: KEY_URLS[id] } : {}),
      configured: missingRequirements(id, environment).length === 0,
    };
  });
  return "error" in resolved ? { configured: false, reason: resolved.error, providers } : { configured: true, providers };
}

export type SetupSaveDependencies = {
  /** The agent's live environment; updated in place so the next session/new resolves the new provider. */
  environment: Record<string, string | undefined>;
  processEnvironment: Record<string, string | undefined>;
  checkOpenRouter?: (key: string) => Promise<KeyCheck>;
  load?: () => Promise<ArchymedesSettings>;
  save?: (settings: ArchymedesSettings) => Promise<string>;
};

export type SetupSaveResult = { ok: true; file: string; note?: string } | { ok: false; error: string };

export async function saveSetup(params: Record<string, unknown>, deps: SetupSaveDependencies): Promise<SetupSaveResult> {
  const provider = typeof params.provider === "string" ? params.provider : "";
  const raw = typeof params.key === "string" ? params.key.trim() : "";
  if (!isProviderId(provider)) return { ok: false, error: `Unknown provider "${provider}".` };
  const target = setupStatus(deps.environment).providers.find((candidate) => candidate.id === provider);
  if (!target?.keyVariable) return { ok: false, error: `${PROVIDER_INFO[provider].label} needs more than a key; run archymedes settings.` };
  if (!raw) return { ok: false, error: "The key is empty." };

  let key: string;
  try {
    key = validateSetting(target.keyVariable as SettingKey, raw);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  let note: string | undefined;
  if (provider === "free" || provider === "openrouter") {
    const result = await (deps.checkOpenRouter ?? ((value: string) => checkOpenRouterKey(value)))(key);
    if (!result.ok && result.reason === "invalid") return { ok: false, error: describeKeyCheckFailure(result) };
    // A network failure says nothing about the key; the first request will report a bad one.
    if (!result.ok) note = `${describeKeyCheckFailure(result)} Saved anyway; the first request will confirm it.`;
  }

  const current = await (deps.load ?? (() => loadSettings(deps.processEnvironment)))();
  const settings: ArchymedesSettings = { ...current, [target.keyVariable]: key, ARCHYMEDES_PROVIDER: provider };
  const file = await (deps.save ?? ((value: ArchymedesSettings) => saveSettings(value, deps.processEnvironment)))(settings);
  Object.assign(deps.environment, mergedEnvironment(settings, deps.processEnvironment));
  return { ok: true, file, ...(note ? { note } : {}) };
}

/** One row of the Providers app: whether it is usable, what it still needs, and the model it would use. */
export type ProviderOverview = {
  id: ProviderId;
  label: string;
  configured: boolean;
  /** The variables still missing; empty when configured. */
  missing: string[];
  /** The one variable a key fills; absent when the provider needs more than a key. */
  keyVariable?: string;
  keyUrl?: string;
  /** What a session on this provider would use: its <PREFIX>_MODEL, else the default. */
  model: string;
  /** ARCHYMEDES_PROVIDER names it: new sessions start here. */
  isDefault: boolean;
  /** What it is set up with: its key, base URL and anything else it requires, secrets masked. */
  fields: ProviderField[];
};

/** Every provider, free first, for a client that lets the person act on them (`_archymedes/providers`). */
export function providerOverview(environment: Record<string, string | undefined>): ProviderOverview[] {
  const preferred = environment.ARCHYMEDES_PROVIDER?.trim().toLowerCase();
  return setupStatus(environment).providers.map((provider) => {
    const info = PROVIDER_INFO[provider.id];
    return {
      ...provider,
      missing: missingRequirements(provider.id, environment),
      model: environment[`${providerEnvPrefix(provider.id)}_MODEL`]?.trim() || info.defaultModel,
      isDefault: preferred === provider.id,
      fields: providerFields(provider.id, environment),
    };
  });
}
