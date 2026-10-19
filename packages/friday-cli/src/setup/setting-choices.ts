import { SETTING_FIELDS, type SettingChoice } from "../platform/settings";
import { builtinThemes } from "../theme/theme";

/**
 * The numbered settings menu (`friday settings`, and a first run without the Go interface): the
 * schema in `platform/settings.ts`, asked one field at a time. Storage and validation stay in
 * platform; what a field offers to pick from, and how it is asked, live here.
 */

/** What a field offers in a list. Themes come from the theme section, which settings storage sits below. */
export function settingChoices(field: (typeof SETTING_FIELDS)[number]): readonly SettingChoice[] {
  if (field.key === "ARCHYMEDES_THEME") return builtinThemes().map((theme) => ({ value: theme.name, label: theme.name, ...(theme.description ? { description: theme.description } : {}) }));
  return "choices" in field && field.choices ? (field.choices as readonly SettingChoice[]) : [];
}
