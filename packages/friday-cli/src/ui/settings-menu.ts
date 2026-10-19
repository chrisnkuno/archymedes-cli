import { controlLabel, resolveControlLanguage } from "../platform/i18n";
import {
  maskSetting, MODEL_FIELD_PROVIDER, sectionOf, SETTING_CANCELLED, SETTING_FIELDS, validateSetting,
  type ArchymedesSettings, type SettingChoice, type SettingKey,
} from "../platform/settings";
import { PROVIDER_IDS, PROVIDER_INFO } from "@archymedes/core/providers/agent-matrix";
import { settingChoices } from "../setup/setting-choices";

export type SettingsPrompts = {
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  write(text: string): void;
  /**
   * Renders an arrow-navigable list and resolves to the chosen value, or undefined if dismissed.
   *
   * Optional, and the menu is written to work without it. Borrowing the keyboard needs a real TTY
   * and a readline to borrow from, which a piped run, a first-run script and every test in this
   * file do not have — so the typed numbered menu remains the base case rather than a degraded one.
   */
  choose?<T>(request: {
    title: string;
    items: readonly { value: T; label: string; description?: string; hint?: string; pinned?: boolean; header?: string }[];
    filter?: boolean;
    initialIndex?: number;
    /** Replaces the chooser's key legend. */
    legend?: string;
  }): Promise<T | undefined>;
};

/** Numbered, screen-reader-friendly settings menu. Secrets are never printed back to the terminal. */
/**
 * The settings that decide whether Archymedes can run at all. Most providers need one key; a
 * generic or Archymedes Cloud endpoint also needs its base URL.
 *
 * Kept as its own list so the first-run menu can ask for exactly that and nothing else: someone who
 * has just installed Archymedes and wants to use Claude should not have to find "Anthropic API key" at
 * position 2 of a long settings list, between unrelated controls. Every
 * other setting has a sensible default and can be changed later from `/settings`.
 */
const PROVIDER_REQUIRED_NAMES = new Set(PROVIDER_IDS.flatMap((id) => PROVIDER_INFO[id].requires));
const PROVIDER_KEY_FIELDS = SETTING_FIELDS.filter((field) => PROVIDER_REQUIRED_NAMES.has(field.key));

export type SettingsMenuOptions = {
  /**
   * Show only the provider keys, with a way to reveal the rest.
   *
   * Used on a first run, where the question is "which provider are you using?" and a wall of
   * twenty-four unrelated options is an obstacle between someone and their first working session.
   */
  focus?: "providers";
  /**
   * What a model field should offer, asked when that field is opened.
   *
   * A model id is the one setting on this menu whose valid answers are neither fixed nor
   * guessable: they belong to the provider, they change without any release of Archymedes, and the key
   * needed to ask has — by the time this field is reached — just been pasted into the field above.
   * Leaving it as free text means typing `claude-sonnet-5` exactly, from memory, and finding out
   * you got it wrong one turn into the next session.
   *
   * Asked lazily rather than up front, because it reaches the network: opening the settings menu
   * must not wait on three providers, and most visits here are not about the model at all.
   * Returning an empty list is the honest "could not ask", and falls back to typing.
   */
  modelChoices?(field: SettingKey, settings: ArchymedesSettings): Promise<readonly SettingChoice[]>;
};

/** What the menu is asking for, when a caller can render a real chooser. */
export type SettingsSelection =
  | { kind: "field"; key: SettingKey }
  | { kind: "expand" }
  | { kind: "done" };

export async function runSettingsMenu(current: ArchymedesSettings, prompts: SettingsPrompts, options: SettingsMenuOptions = {}): Promise<ArchymedesSettings> {
  const settings = { ...current };
  let focused = options.focus === "providers";
  /** Where the field list reopens after editing something. */
  let cursor = 0;
  for (;;) {
    const language = resolveControlLanguage(settings.ARCHYMEDES_LANGUAGE);
    const fields = focused ? PROVIDER_KEY_FIELDS : SETTING_FIELDS;
    const describe = (field: typeof SETTING_FIELDS[number]) => {
      const value = settings[field.key];
      return "secret" in field && field.secret ? maskSetting(value) : value || "not set";
    };

    let selection: SettingsSelection;
    if (prompts.choose) {
      // Arrow-driven when the caller can borrow the keyboard. The rows carry their current values
      // so the menu answers "what is set?" without anyone having to open each field to find out.
      const items = [
        ...fields.map((field) => ({ value: { kind: "field", key: field.key } as SettingsSelection, label: field.label, hint: describe(field), ...(focused ? {} : { header: sectionOf(field.key) }) })),
        ...(focused ? [{ value: { kind: "expand" } as SettingsSelection, label: "Everything else", description: "base URLs, models, pricing, voice, keys", pinned: true }] : []),
        { value: { kind: "done" } as SettingsSelection, label: `${controlLabel(language, "saved")} / ${controlLabel(language, "exit")}`, pinned: true },
      ];
      const chosen = await prompts.choose({
        title: `Friday ${controlLabel(language, "settings")}`,
        items,
        // Filterable: sixty rows is not a menu you arrow through to row fifty, and the value
        // lists already filter — the field list refusing typed queries while they do would be
        // the one screen where typing does nothing.
        filter: true,
        // Reopens where the user was, not at the top. Setting three things in a row otherwise means
        // scrolling back down twice, and the list is long enough for that to be the whole cost of
        // using it.
        initialIndex: cursor,
        // Esc here is "I'm done", and what is done is kept — said on screen, because Esc in most
        // menus means "throw it away" and nobody should have to find out which by trying it.
        legend: "↑↓ move · Enter edit · Esc done (saves)",
      });
      // Escape means "leave the menu", the same as choosing the exit row.
      selection = chosen ?? { kind: "done" };
      const chosenIndex = items.findIndex((item) => item.value === chosen);
      if (chosenIndex >= 0) cursor = chosenIndex;
    } else {
      // The typed path stays, and stays first-class. It is what a pipe, a test and a terminal too
      // small to paint into all use, and it is the accessible reading of the same menu.
      prompts.write(`\nArchymedes ${controlLabel(language, "settings")}\n`);
      let lastSection: string | undefined;
      fields.forEach((field, index) => {
        const section = focused ? undefined : sectionOf(field.key);
        if (section && section !== lastSection) prompts.write(`  ${section}\n`);
        lastSection = section;
        prompts.write(`  ${String(index + 1).padStart(2)}. ${field.label}: ${describe(field)}\n`);
      });
      if (focused) prompts.write("   a. everything else (base URLs, models, pricing, voice, keys)\n");
      prompts.write(`   q. ${controlLabel(language, "saved")} / ${controlLabel(language, "exit")}\n`);
      const choice = (await prompts.ask(`${controlLabel(language, "choose")}: `)).trim().toLowerCase();
      if (choice === "q" || choice === "done" || choice === "exit") selection = { kind: "done" };
      else if (focused && choice === "a") selection = { kind: "expand" };
      else {
        const field = fields[Number(choice) - 1];
        if (!field) {
          prompts.write(`Choose a number from the menu${focused ? ", a for the full list" : ""}, or q to save.\n`);
          continue;
        }
        selection = { kind: "field", key: field.key };
      }
    }

    if (selection.kind === "done") return settings;
    // The full list is a different list; a position in the short one means nothing in it.
    if (selection.kind === "expand") { focused = false; cursor = 0; continue; }
    const field = SETTING_FIELDS.find((candidate) => candidate.key === selection.key)!;

    // A model field's answers come from the provider, asked with the key that was just pasted, so
    // they are fetched at the moment the field is opened rather than baked into the field list.
    // An empty answer — no key yet, provider unreachable, no chooser to paint with — falls through
    // to the free-text prompt, which is still a complete way to set this.
    const dynamic = MODEL_FIELD_PROVIDER[field.key] && options.modelChoices
      ? await options.modelChoices(field.key, settings).catch(() => [])
      : [];
    const choices: readonly SettingChoice[] = dynamic.length > 0
      ? dynamic
      : settingChoices(field);

    // A field with a fixed set of answers is picked, not typed — but only when there is a chooser
    // to pick with. Without one it falls back to the same free-text prompt it always had.
    if (choices.length > 0 && prompts.choose) {
      const picked = await prompts.choose({
        title: field.label,
        filter: true,
        items: [
          ...choices.map((choice) => ({
            value: choice.value,
            label: choice.label,
            ...(choice.description ? { description: choice.description } : {}),
            ...(settings[field.key] === choice.value ? { hint: "current" } : {}),
          })),
          { value: "-", label: "Clear this setting", pinned: true },
        ],
        initialIndex: Math.max(0, choices.findIndex((choice) => choice.value === settings[field.key])),
      });
      if (picked === undefined) continue;
      if (picked === "-") {
        delete settings[field.key];
        prompts.write(`${field.label} cleared.\n`);
        continue;
      }
      settings[field.key] = validateSetting(field.key, picked);
      prompts.write(`${field.label} saved in this menu.\n`);
      continue;
    }

    const raw = await ("secret" in field && field.secret ? prompts.askSecret(`${field.label} (paste hidden; - clears; Esc keeps): `) : prompts.ask(`${field.label} (- clears; Esc keeps): `));
    if (raw === SETTING_CANCELLED) {
      prompts.write(`${field.label} unchanged.\n`);
      continue;
    }
    if (raw.trim() === "-") {
      delete settings[field.key];
      prompts.write(`${field.label} cleared.\n`);
      continue;
    }
    try {
      settings[field.key] = validateSetting(field.key, raw);
      prompts.write(`${field.label} saved in this menu.\n`);
    } catch (error) {
      prompts.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
