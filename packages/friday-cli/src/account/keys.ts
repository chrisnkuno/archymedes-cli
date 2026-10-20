import { loadSettings, saveSettings, type ArchymedesSettings, type SettingKey } from "../platform/settings";
import { AccountClient, AccountError } from "./client";

/**
 * Moving a person's provider keys between this computer and their account.
 *
 * Direction matters. A push needs only the right to add keys, which every linked computer has; a pull
 * needs `vault:read`, which the person gives a computer explicitly when they confirm its link. What is
 * printed is always a hint (the last four characters), never a key.
 */

/** The vault slot for each provider, and the setting Friday keeps its key in. */
export const SLOT_SETTINGS: Readonly<Record<string, SettingKey>> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
};

type Environment = Record<string, string | undefined>;
export type KeyResult = { slot: string; status: "pushed" | "pulled" | "skipped" | "failed"; detail: string };

const mask = (value: string): string => `…${value.slice(-4)}`;

function wanted(only: readonly string[] | undefined): string[] {
  const slots = Object.keys(SLOT_SETTINGS);
  if (!only || only.length === 0) return slots;
  const unknown = only.filter((slot) => !slots.includes(slot));
  if (unknown.length > 0) throw new Error(`No such provider: ${unknown.join(", ")}. Choose from ${slots.join(", ")}.`);
  return slots.filter((slot) => only.includes(slot));
}

/** Sends the keys saved on this computer (and set in its environment) to the account. */
export async function pushKeys(deps: { client: AccountClient; environment?: Environment; only?: readonly string[] }): Promise<KeyResult[]> {
  const environment = deps.environment ?? process.env;
  const settings = await loadSettings(environment);
  const results: KeyResult[] = [];
  for (const slot of wanted(deps.only)) {
    const name = SLOT_SETTINGS[slot];
    const value = (settings[name] ?? environment[name] ?? "").trim();
    if (!value) { results.push({ slot, status: "skipped", detail: "no key on this computer" }); continue; }
    try {
      const stored = await deps.client.putKey(slot, value);
      results.push({ slot, status: "pushed", detail: stored.hint ?? mask(value) });
    } catch (error) {
      results.push({ slot, status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** Fetches the account's keys into this computer's settings. Needs the right to download; keeps a local key unless told to replace it. */
export async function pullKeys(deps: { client: AccountClient; environment?: Environment; only?: readonly string[]; force?: boolean }): Promise<KeyResult[]> {
  const environment = deps.environment ?? process.env;
  const catalog = await deps.client.vault();
  const settings: ArchymedesSettings = await loadSettings(environment);
  const results: KeyResult[] = [];
  let changed = false;
  for (const slot of wanted(deps.only)) {
    const name = SLOT_SETTINGS[slot];
    const entry = catalog.slots.find((candidate) => candidate.slot === slot);
    if (!entry?.set) { results.push({ slot, status: "skipped", detail: "not in your account" }); continue; }
    if (settings[name] && !deps.force) { results.push({ slot, status: "skipped", detail: "already set here (use --force to replace it)" }); continue; }
    try {
      const value = await deps.client.revealKey(slot);
      settings[name] = value;
      changed = true;
      results.push({ slot, status: "pulled", detail: mask(value) });
    } catch (error) {
      if (error instanceof AccountError && error.status === 403) {
        throw new AccountError("This computer was not approved to download your keys. Run `friday login` again and, when you confirm the code, tick “let this device download my keys”.", 403, "scope");
      }
      results.push({ slot, status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  if (changed) await saveSettings(settings, environment);
  return results;
}
