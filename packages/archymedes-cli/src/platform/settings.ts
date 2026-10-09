import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isFreeModelId } from "@archymedes/core/providers/free-catalog";
import { CONTROL_LANGUAGES, controlLabel, resolveControlLanguage } from "./i18n";
import { SUPPORTED_COUNTRIES, currencyForCountry, normalizeCountryCode } from "./local-currency";
import { isCurrency } from "@archymedes/core/money";
import { PROVIDER_IDS, PROVIDER_INFO, isProviderId, type ProviderId } from "@archymedes/core/providers/agent-matrix";

/**
 * A value that can be picked from a list, with the human name shown beside the stored code.
 *
 * `description` is optional detail rendered beside a choice — a model's price, or the fact that
 * this build has no published rate for it.
 */
export type SettingChoice = { value: string; label: string; description?: string };

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", zh: "中文", hi: "हिन्दी", es: "Español", fr: "Français",
  ar: "العربية", bn: "বাংলা", pt: "Português", ru: "Русский", ur: "اردو",
  ja: "日本語", ko: "한국어", de: "Deutsch", id: "Bahasa Indonesia", vi: "Tiếng Việt", tr: "Türkçe",
};

const COUNTRY_NAMES: Record<string, string> = {
  RW: "Rwanda", EG: "Egypt", KE: "Kenya", UG: "Uganda", TZ: "Tanzania", NG: "Nigeria", ZA: "South Africa",
  GH: "Ghana", ET: "Ethiopia", US: "United States", CA: "Canada", GB: "United Kingdom", FR: "France",
  DE: "Germany", ES: "Spain", IT: "Italy", NL: "Netherlands", BE: "Belgium", CH: "Switzerland",
  SE: "Sweden", NO: "Norway", DK: "Denmark", PL: "Poland", CZ: "Czechia", TR: "Türkiye", AE: "United Arab Emirates",
  SA: "Saudi Arabia", IL: "Israel", IN: "India", CN: "China", JP: "Japan", SG: "Singapore",
  AU: "Australia", NZ: "New Zealand", BR: "Brazil", MX: "Mexico",
};

const CONTROL_LANGUAGE_CODES = new Set(Object.keys(CONTROL_LANGUAGES));
const LANGUAGE_CHOICES: readonly SettingChoice[] = Object.keys(CONTROL_LANGUAGES).map((value) => ({ value, label: LANGUAGE_NAMES[value] ?? value }));

/**
 * Countries, named, each showing the currency choosing it produces.
 *
 * Sorted by name rather than by code, because someone looking for Rwanda is looking for "Rwanda".
 */
const COUNTRY_CHOICES: readonly SettingChoice[] = SUPPORTED_COUNTRIES
  .map((code) => ({ value: code, label: `${COUNTRY_NAMES[code] ?? code} (${code}) — ${currencyForCountry(code)}` }))
  .sort((left, right) => left.label.localeCompare(right.label));

const CURRENCY_CHOICES: readonly SettingChoice[] = [...new Set(SUPPORTED_COUNTRIES.map((code) => currencyForCountry(code)!))]
  .sort()
  .map((value) => ({ value, label: value }));

const AUTO_UPDATE_CHOICES: readonly SettingChoice[] = [
  { value: "install", label: "Check daily and install automatically (default)" },
  { value: "check", label: "Check daily and tell me only" },
  { value: "off", label: "Never check" },
];

const ON_OFF_CHOICES: readonly SettingChoice[] = [
  { value: "off", label: "Off — rule-based suggestions only" },
  { value: "on", label: "On — the model may add up to two more" },
];

const JEV_CHOICES: readonly SettingChoice[] = [
  { value: "on", label: "On — judge turns and annotate approvals when TYPESAFE_API_KEY is set (default)" },
  { value: "off", label: "Off — never call Jev, even with a key configured" },
];

const CODE_COLOR_CHOICES: readonly SettingChoice[] = [
  { value: "vscode", label: "VS Code colours — Dark+ or Light+ to match the theme (default)" },
  { value: "theme", label: "Theme colours — code painted in the theme's own palette" },
];

const SHOW_HIDE_CHOICES: readonly SettingChoice[] = [
  { value: "on", label: "On (default)" },
  { value: "off", label: "Off" },
];

const TOKEN_SAVER_CHOICES: readonly SettingChoice[] = [
  { value: "on", label: "On — trim prompts and history to stretch free limits (default)" },
  { value: "off", label: "Off — send everything, as with a paid model" },
];

const TOKEN_METER_CHOICES: readonly SettingChoice[] = [
  { value: "on", label: "On — show tokens used in the status line" },
  { value: "off", label: "Off" },
];

const SIMPLE_CHOICES: readonly SettingChoice[] = [
  { value: "on", label: "On — a quiet start and a short /help (default)" },
  { value: "off", label: "Off — the full banner, tips and grouped help" },
];

const RESUME_CHOICES: readonly SettingChoice[] = [
  { value: "ask", label: "Ask — offer to continue the last chat in this folder (default)" },
  { value: "always", label: "Always — continue the last chat automatically" },
  { value: "never", label: "Never — always start fresh" },
];

const AUTOSAVE_CHOICES: readonly SettingChoice[] = [
  { value: "off", label: "Off — save with Ctrl+S (default)" },
  { value: "on", label: "On — save a second after you stop typing" },
];

const PROVIDER_CHOICES: readonly SettingChoice[] = PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDER_INFO[id].label }));

/**
 * Settings Archymedes may persist. Unknown JSON keys are ignored on read.
 *
 * A `choices` list means the value is picked, not typed. Every one of these was previously a
 * free-text box whose valid answers lived only in the label and the validator — you had to know
 * that Rwanda is `RW` before the field could help you, which is backwards: the list of countries
 * Archymedes can price in is a fact it already holds.
 */
export const SETTING_FIELDS = [
  // No static `choices`: the built-in theme names live in `theme/`, which sits above `platform` and
  // may not be reached from here. They arrive through `SettingsMenuOptions.themeChoices` instead,
  // supplied by the `app/` caller — and a session that supplies none still sets a theme by typing,
  // which is what `validateSetting` has always accepted anyway (a user's own theme file is valid).
  { key: "ARCHYMEDES_THEME", label: "Theme — colours for the whole CLI (/theme <name> also saves it)", section: "Appearance" },
  { key: "ARCHYMEDES_CODE_COLORS", label: "Code colours", choices: CODE_COLOR_CHOICES },
  { key: "ARCHYMEDES_CODE_LINE_NUMBERS", label: "Line numbers in code blocks", choices: SHOW_HIDE_CHOICES },
  { key: "ARCHYMEDES_SIMPLE", label: "Simple mode — quiet start, short help", choices: SIMPLE_CHOICES },
  { key: "ARCHYMEDES_LANGUAGE", label: "Control language", choices: LANGUAGE_CHOICES },
  { key: "ARCHYMEDES_RESUME", label: "Continue your last chat at startup", choices: RESUME_CHOICES, section: "Behaviour" },
  { key: "ARCHYMEDES_EDITOR_AUTOSAVE", label: "Auto-save in /edit", choices: AUTOSAVE_CHOICES },
  // Off by default, and the label says what it costs: the deterministic suggestions are free and
  // instant, and this buys two extra project-specific ones for a small model call per turn. A
  // feature that quietly bills a person for a hint is a feature they turn off once and distrust
  // afterwards.
  { key: "ARCHYMEDES_SUGGEST_MODEL", label: "Ask the model for extra suggestions (a small extra call per turn)", choices: ON_OFF_CHOICES },
  // Three states rather than a switch: looking and installing are different decisions, and the one
  // people want to make separately is whether Archymedes may replace itself without being asked.
  { key: "ARCHYMEDES_AUTO_UPDATE", label: "Automatic updates — install daily by default", choices: AUTO_UPDATE_CHOICES },
  { key: "ARCHYMEDES_JEV", label: "Jev second opinion — post-turn verdicts and pre-tool checks", choices: JEV_CHOICES },
  { key: "ARCHYMEDES_KEYS", label: "Key bindings, e.g. /diff=alt+d,/wander=off" },
  { key: "FREE_MODEL", label: "Free mode model (openrouter/free or publisher/model:free)", section: "Free mode" },
  { key: "ARCHYMEDES_TOKEN_SAVER", label: "Free mode token saver", choices: TOKEN_SAVER_CHOICES },
  { key: "ARCHYMEDES_TOKEN_METER", label: "Token meter in the status line", choices: TOKEN_METER_CHOICES },
  { key: "ARCHYMEDES_COUNTRY", label: "Location — sets the currency costs are shown in", choices: COUNTRY_CHOICES, section: "Money" },
  { key: "ARCHYMEDES_CURRENCY", label: "Display currency (overrides the one your location implies)", choices: CURRENCY_CHOICES },
  { key: "ARCHYMEDES_ACCOUNT_BALANCE", label: "Tracked spend balance — drawn down by each turn's measured cost" },
  { key: "ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY", label: "Currency of the tracked balance (defaults to the display currency)" },
  { key: "ARCHYMEDES_LOW_BALANCE", label: "Low-balance alert threshold, in the balance currency" },
  { key: "ARCHYMEDES_CRITICAL_BALANCE", label: "Critical-balance threshold, in the balance currency" },
  { key: "ARCHYMEDES_PROVIDER", label: "Default provider", choices: PROVIDER_CHOICES, section: "Providers" },
  { key: "ARCHYMEDES_FALLBACK_MODEL", label: "Fallback after transient provider failure — ask, or provider:model" },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", secret: true },
  { key: "ANTHROPIC_BASE_URL", label: "Anthropic base URL", url: true },
  { key: "ANTHROPIC_MODEL", label: "Anthropic model" },
  { key: "OPENAI_API_KEY", label: "OpenAI API key", secret: true },
  { key: "OPENAI_BASE_URL", label: "OpenAI-compatible base URL", url: true },
  { key: "OPENAI_MODEL", label: "OpenAI model" },
  { key: "ARCHYMEDES_CLOUD_TOKEN", label: "Archymedes Cloud access token", secret: true },
  { key: "ARCHYMEDES_CLOUD_BASE_URL", label: "Archymedes Cloud base URL", url: true },
  { key: "ARCHYMEDES_CLOUD_MODEL", label: "Archymedes Cloud route (default auto)" },
  { key: "ARCHYMEDES_CLOUD_MAXIMUM_MICROS", label: "Maximum cloud credits reserved per model call, in micros" },
  { key: "ARCHYMEDES_CLOUD_CURRENCY", label: "Cloud credit currency" },
  { key: "ARCHYMEDES_CLOUD_REGION", label: "Cloud routing region" },
  { key: "ARCHYMEDES_CLOUD_DATA_POLICY", label: "Cloud data policy" },
  { key: "ARCHYMEDES_CLOUD_QUALITY_FLOOR", label: "Cloud routing quality floor (0 to 1)" },
  { key: "ARCHYMEDES_CLOUD_TASK_KIND", label: "Cloud task kind (coding, design, architecture, security, research, deployment)" },
  { key: "GOOGLE_API_KEY", label: "Google Gemini API key", secret: true },
  { key: "GOOGLE_BASE_URL", label: "Google Gemini base URL", url: true },
  { key: "GOOGLE_MODEL", label: "Google Gemini model" },
  { key: "XAI_API_KEY", label: "xAI (Grok) API key", secret: true },
  { key: "XAI_BASE_URL", label: "xAI base URL", url: true },
  { key: "XAI_MODEL", label: "xAI (Grok) model" },
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek API key", secret: true },
  { key: "DEEPSEEK_BASE_URL", label: "DeepSeek base URL", url: true },
  { key: "DEEPSEEK_MODEL", label: "DeepSeek model" },
  { key: "MISTRAL_API_KEY", label: "Mistral API key", secret: true },
  { key: "MISTRAL_BASE_URL", label: "Mistral base URL", url: true },
  { key: "MISTRAL_MODEL", label: "Mistral model" },
  { key: "GROQ_API_KEY", label: "Groq API key", secret: true },
  { key: "GROQ_BASE_URL", label: "Groq base URL", url: true },
  { key: "GROQ_MODEL", label: "Groq model" },
  { key: "OPENAI_COMPATIBLE_API_KEY", label: "OpenAI-compatible API key", secret: true },
  { key: "OPENAI_COMPATIBLE_BASE_URL", label: "OpenAI-compatible base URL", url: true },
  { key: "OPENAI_COMPATIBLE_MODEL", label: "OpenAI-compatible model" },
  { key: "OLLAMA_BASE_URL", label: "Ollama base URL (default http://localhost:11434/v1)", url: true },
  { key: "OLLAMA_MODEL", label: "Ollama model" },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API key (direct + free mode)", secret: true },
  { key: "OPENROUTER_MODEL", label: "OpenRouter model (default openrouter/auto; any publisher/model id)" },
  { key: "OPENROUTER_BASE_URL", label: "OpenRouter base URL", url: true },
  { key: "OPENROUTER_HTTP_REFERER", label: "OpenRouter app URL for rankings (optional)", url: true },
  { key: "OPENROUTER_APP_TITLE", label: "OpenRouter app title for rankings (optional)" },
  { key: "TYPESAFE_API_KEY", label: "TypeSafe API key for Jev verdicts (optional)", secret: true },
  { key: "TYPESAFE_MODEL", label: "Jev model (default jev-latest)" },
  { key: "E2B_API_KEY", label: "E2B API key", secret: true, section: "Tools & voice" },
  { key: "E2B_CODING_TEMPLATE", label: "E2B template" },
  { key: "EXA_API_KEY", label: "Exa search API key", secret: true },
  { key: "EXA_BASE_URL", label: "Exa base URL", url: true },
  { key: "VOICE_TRANSCRIPTION_URL", label: "Speech-to-text URL", url: true },
  { key: "VOICE_MODEL", label: "Speech-to-text model" },
  { key: "VOICE_INPUT_DEVICE", label: "Microphone device override" },
  { key: "MODEL_INPUT_PER_MILLION", label: "Input price per million tokens", section: "Price overrides" },
  { key: "MODEL_OUTPUT_PER_MILLION", label: "Output price per million tokens" },
  { key: "MODEL_CACHED_INPUT_PER_MILLION", label: "Cached input price per million tokens" },
  { key: "MODEL_PRICE_CURRENCY", label: "Model price currency" },
  { key: "MODEL_PRICE_MODEL", label: "Model the price override applies to" },
] as const;

/**
 * Settings Archymedes records for itself and never offers in the menu: acknowledgements and the
 * like, which a person has no reason to edit but which must survive a restart.
 *
 * `ARCHYMEDES_FREE_PRIVACY_ACK` is `yes` once the free-mode privacy notice has been shown.
 */
export const INTERNAL_SETTING_KEYS = ["ARCHYMEDES_FREE_PRIVACY_ACK"] as const;
export type InternalSettingKey = typeof INTERNAL_SETTING_KEYS[number];

export type SettingKey = typeof SETTING_FIELDS[number]["key"];
export type ArchymedesSettings = Partial<Record<SettingKey | InternalSettingKey, string>>;

/** Native per-user config location on Windows, macOS and freedesktop systems. */
export function settingsDirectory(environment: Record<string, string | undefined> = process.env, platform = process.platform): string {
  if (environment.ARCHYMEDES_CONFIG_DIR?.trim()) return path.resolve(environment.ARCHYMEDES_CONFIG_DIR);
  if (platform === "win32") return path.join(environment.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming"), "Archymedes");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Archymedes");
  return path.join(environment.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "archymedes");
}

export function settingsFile(environment: Record<string, string | undefined> = process.env, platform = process.platform): string {
  return path.join(settingsDirectory(environment, platform), "settings.json");
}

function cleanSettings(value: unknown): ArchymedesSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const settings: ArchymedesSettings = {};
  for (const field of SETTING_FIELDS) {
    const item = source[field.key];
    if (typeof item === "string" && item.trim()) settings[field.key] = item.trim();
  }
  for (const key of INTERNAL_SETTING_KEYS) {
    const item = source[key];
    if (typeof item === "string" && item.trim()) settings[key] = item.trim();
  }
  return settings;
}

export async function loadSettings(environment: Record<string, string | undefined> = process.env, platform = process.platform): Promise<ArchymedesSettings> {
  try {
    return cleanSettings(JSON.parse(await fs.readFile(settingsFile(environment, platform), "utf8")));
  } catch {
    return {};
  }
}

export async function saveSettings(settings: ArchymedesSettings, environment: Record<string, string | undefined> = process.env, platform = process.platform): Promise<string> {
  const directory = settingsDirectory(environment, platform);
  const file = settingsFile(environment, platform);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(cleanSettings(settings), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600).catch(() => undefined);
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
  return file;
}

export function mergedEnvironment(settings: ArchymedesSettings, environment: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  // Real environment variables win, which keeps CI, containers and one-off shell overrides
  // predictable even after a user has configured the interactive CLI.
  return { ...settings, ...environment };
}

export function maskSetting(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 8) return "set (hidden)";
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

/**
 * Settings whose answer is one of a few words. Checked case-insensitively and stored lowercased,
 * so `ON` in a hand-edited settings.json means the same as `on`.
 */
const ENUM_SETTINGS: Partial<Record<SettingKey, readonly string[]>> = {
  ARCHYMEDES_CODE_COLORS: ["vscode", "theme"],
  ARCHYMEDES_CODE_LINE_NUMBERS: ["on", "off"],
  ARCHYMEDES_TOKEN_SAVER: ["on", "off"],
  ARCHYMEDES_TOKEN_METER: ["on", "off"],
  ARCHYMEDES_SIMPLE: ["on", "off"],
  ARCHYMEDES_RESUME: ["ask", "always", "never"],
  ARCHYMEDES_EDITOR_AUTOSAVE: ["on", "off"],
  ARCHYMEDES_SUGGEST_MODEL: ["on", "off"],
  ARCHYMEDES_AUTO_UPDATE: ["install", "check", "off"],
};

/** Returned by `SettingsPrompts.ask` when the person pressed Esc: leave this field as it was. */
export const SETTING_CANCELLED = "\u0000cancelled";

export function validateSetting(key: SettingKey, raw: string): string {
  const value = raw.trim();
  const field = SETTING_FIELDS.find((candidate) => candidate.key === key)!;
  if (!value) throw new Error("Value cannot be empty. Enter - in the menu to clear it.");
  const allowed = ENUM_SETTINGS[key];
  if (allowed) {
    const lowered = value.toLowerCase();
    if (!allowed.includes(lowered)) throw new Error(`Choose one of: ${allowed.join(", ")}.`);
    return lowered;
  }
  if (key === "ARCHYMEDES_THEME") {
    // Built-in names are offered in the menu, but a theme file the user wrote is just as valid;
    // the name is checked for shape here and for existence when the session starts.
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Theme names are letters, digits, - and _ — see /theme list.");
    return value.toLowerCase();
  }
  if (key === "FREE_MODEL" && !isFreeModelId(value)) throw new Error("Choose openrouter/free or an exact publisher/model:free ID.");
  if ("url" in field && field.url) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Enter a complete URL, for example https://api.example.com/v1."); }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("URLs must use HTTPS (HTTP is allowed only for localhost).");
    return url.href.replace(/\/$/, "");
  }
  if (/PER_MILLION$/.test(key)) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Price must be a non-negative number.");
  }
  if (key === "ARCHYMEDES_LOW_BALANCE" || key === "ARCHYMEDES_CRITICAL_BALANCE" || key === "ARCHYMEDES_ACCOUNT_BALANCE") {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Must be a non-negative number.");
  }
  if (key === "ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY" && !/^[A-Za-z]{3}$/.test(value)) throw new Error("Currency must be a three-letter ISO code such as USD.");
  if (key === "ARCHYMEDES_CLOUD_CURRENCY" && !/^[A-Za-z]{3}$/.test(value)) throw new Error("Currency must be a three-letter ISO code such as USD.");
  if (key === "ARCHYMEDES_CLOUD_MAXIMUM_MICROS" && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)) throw new Error("Maximum must be a positive integer number of micros.");
  if (key === "ARCHYMEDES_CLOUD_QUALITY_FLOOR" && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)) throw new Error("Quality floor must be between 0 and 1.");
  if (key === "MODEL_PRICE_CURRENCY" && !/^[A-Za-z]{3}$/.test(value)) throw new Error("Currency must be a three-letter ISO code such as USD.");
  if (key === "ARCHYMEDES_LANGUAGE" && !CONTROL_LANGUAGE_CODES.has(value.toLowerCase())) throw new Error(`Choose one of: ${[...CONTROL_LANGUAGE_CODES].join(", ")}.`);
  if (key === "ARCHYMEDES_PROVIDER" && !isProviderId(value.toLowerCase())) throw new Error(`Choose one of: ${PROVIDER_IDS.join(", ")}.`);
  if (key === "ARCHYMEDES_PROVIDER") return value.toLowerCase();
  if (key === "ARCHYMEDES_JEV" && !["on", "off"].includes(value.toLowerCase())) throw new Error("Choose on or off.");
  if (key === "ARCHYMEDES_JEV") return value.toLowerCase();
  if (key === "ARCHYMEDES_FALLBACK_MODEL" && value.toLowerCase() !== "ask") {
    const match = /^([a-z-]+)[:/]\S+$/i.exec(value);
    if (!match || !isProviderId(match[1].toLowerCase())) {
      throw new Error("Choose ask, or enter an explicit provider:model such as openai:gpt-5.4-mini.");
    }
  }
  if (key === "ARCHYMEDES_COUNTRY") {
    const country = normalizeCountryCode(value);
    if (!country) throw new Error("Enter a two-letter ISO country code, such as RW or EG.");
    // Refused rather than accepted-and-ignored: the point of setting a location is the currency,
    // and a code with no currency behind it would save cleanly and then change nothing.
    if (!currencyForCountry(country)) {
      throw new Error(`No local currency is known for ${country}. Set the display currency directly instead, or choose one of: ${SUPPORTED_COUNTRIES.join(", ")}.`);
    }
    return country;
  }
  if (key === "ARCHYMEDES_CURRENCY") {
    const currency = value.toUpperCase();
    if (!isCurrency(currency)) throw new Error(`${currency} is not a currency Archymedes can convert to. Leave this empty to use the one your location implies.`);
    return currency;
  }
  return key === "MODEL_PRICE_CURRENCY" ? value.toUpperCase() : value;
}

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
  /**
   * What the theme field should offer.
   *
   * Plain data rather than a callback, unlike `modelChoices`: the built-in themes are compiled in
   * and answering costs nothing, so there is no reason to defer it. It is passed in rather than
   * read here because the themes live in `theme/`, a section `platform` may not import — see the
   * `ARCHYMEDES_THEME` field. Omitted, the field falls back to free text, which still sets a theme.
   */
  themeChoices?: readonly SettingChoice[];
};

/**
 * The settings whose value is a model id, and whose provider therefore knows the answers.
 *
 * Ollama is included: a local server's installed models are exactly as unguessable as a hosted
 * provider's, and `/v1/models` is how it says which it has.
 */
export const MODEL_FIELD_PROVIDER: Partial<Record<SettingKey, ProviderId>> = {
  FREE_MODEL: "free",
  ANTHROPIC_MODEL: "anthropic",
  OPENAI_MODEL: "openai",
  ARCHYMEDES_CLOUD_MODEL: "archymedes-cloud",
  OPENROUTER_MODEL: "openrouter",
  GOOGLE_MODEL: "google",
  XAI_MODEL: "xai",
  DEEPSEEK_MODEL: "deepseek",
  MISTRAL_MODEL: "mistral",
  GROQ_MODEL: "groq",
  OPENAI_COMPATIBLE_MODEL: "openai-compatible",
  OLLAMA_MODEL: "ollama",
};

/** The section heading a field sits under: the nearest field at or above it that names one. */
export function sectionOf(key: SettingKey): string | undefined {
  let section: string | undefined;
  for (const field of SETTING_FIELDS) {
    if ("section" in field && field.section) section = field.section;
    if (field.key === key) return section;
  }
  return undefined;
}

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
        title: `Archymedes ${controlLabel(language, "settings")}`,
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
      : field.key === "ARCHYMEDES_THEME" && options.themeChoices
        ? options.themeChoices
        : [];
    const choices: readonly SettingChoice[] = dynamic.length > 0
      ? dynamic
      : ("choices" in field && field.choices ? field.choices : []);

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
