import { loadSettings, maskSetting, mergedEnvironment, saveSettings, sectionOf, SETTING_FIELDS, settingsFile, validateSetting, type ArchymedesSettings, type SettingKey } from "../platform/settings";
import { settingChoices } from "../setup/setting-choices";

/**
 * The settings menu as data, for a client that draws it (the Go interface). The fields, their
 * sections, choices and validation are the terminal menu's own — `SETTING_FIELDS` and
 * `validateSetting` — so the two menus cannot disagree about what is allowed.
 *
 * A secret's value never leaves this process: the client gets whether it is set and a masked form.
 */

export type SettingRow = {
  key: SettingKey;
  label: string;
  section: string;
  kind: "choice" | "text" | "secret";
  choices?: Array<{ value: string; label: string }>;
  /** The stored value, or its masked form for a secret; empty when unset. */
  value: string;
  isSet: boolean;
  /** A real environment variable overrides the stored value, so editing it here would change nothing visible. */
  overriddenByEnvironment: boolean;
};

export type SettingsList = { file: string; rows: SettingRow[] };

export async function listSettings(processEnvironment: Record<string, string | undefined>): Promise<SettingsList> {
  const stored = await loadSettings(processEnvironment);
  const rows: SettingRow[] = SETTING_FIELDS.map((field) => {
    const secret = "secret" in field && field.secret === true;
    const listed = settingChoices(field);
    const choices = listed.length > 0 ? listed : undefined;
    const value = stored[field.key] ?? "";
    return {
      key: field.key,
      label: field.label,
      section: sectionOf(field.key) ?? "General",
      kind: secret ? "secret" : choices ? "choice" : "text",
      ...(choices ? { choices: choices.map((choice) => ({ value: choice.value, label: choice.label })) } : {}),
      value: secret && value ? maskSetting(value) : value,
      isSet: value !== "",
      overriddenByEnvironment: Boolean(processEnvironment[field.key]) && processEnvironment[field.key] !== value,
    };
  });
  return { file: settingsFile(processEnvironment), rows };
}

export type SettingsSetResult = { ok: true; file: string; value: string; isSet: boolean } | { ok: false; error: string };

export type SettingsSetDependencies = {
  /** The agent's live environment; updated in place so the next session picks the change up. */
  environment: Record<string, string | undefined>;
  processEnvironment: Record<string, string | undefined>;
};

/** Saves one setting; an empty value clears it. Validation errors come back as text, never thrown. */
export async function setSetting(params: Record<string, unknown>, deps: SettingsSetDependencies): Promise<SettingsSetResult> {
  const key = typeof params.key === "string" ? params.key : "";
  const raw = typeof params.value === "string" ? params.value : "";
  const field = SETTING_FIELDS.find((candidate) => candidate.key === key);
  if (!field) return { ok: false, error: `No setting named ${key || "(none)"}.` };
  const current = await loadSettings(deps.processEnvironment);
  const next: ArchymedesSettings = { ...current };
  let stored = "";
  if (raw.trim() === "") {
    delete next[field.key];
  } else {
    try {
      stored = validateSetting(field.key, raw);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    next[field.key] = stored;
  }
  let file: string;
  try {
    file = await saveSettings(next, deps.processEnvironment);
  } catch (error) {
    return { ok: false, error: `Could not save: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Cleared keys must leave the live environment too, or the old value keeps being used.
  if (raw.trim() === "" && deps.environment[field.key] === current[field.key]) delete deps.environment[field.key];
  Object.assign(deps.environment, mergedEnvironment(next, deps.processEnvironment));
  const secret = "secret" in field && field.secret === true;
  return { ok: true, file, value: secret && stored ? maskSetting(stored) : stored, isSet: stored !== "" };
}
