import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isFreeModelId } from "@archymedes/core/providers/free-catalog";
import { WEB_SEARCH_CHOICES } from "@archymedes/core/providers/web-search";
import { CONTROL_LANGUAGES } from "./i18n";
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

// Go is the default and the way back is one setting, read by the `friday` binary itself before
// anything starts (cmd/friday/engine.go): no flag to remember. Friday still runs a session on the
// TypeScript engine on its own when the session needs what only it has (Claude Code, Codex, a
// Docker or E2B sandbox, Archymedes Cloud, keyless free mode).
const ENGINE_CHOICES: readonly SettingChoice[] = [
  { value: "go", label: "Go — Friday's engine: background sub-agents, steering, restart-safe sessions (default)" },
  { value: "ts", label: "TypeScript — the earlier engine: Claude Code, Codex, sandboxes, /undo, /cost, /review" },
];

const TEST_FIRST_CHOICES: readonly SettingChoice[] = [
  { value: "on", label: "On — tests that define done, then the code, then a light static check (default)" },
  { value: "off", label: "Off — verify with whatever the change needs" },
];

const SANDBOX_CHOICES: readonly SettingChoice[] = [
  { value: "off", label: "Off — commands run as you would run them (default)" },
  { value: "on", label: "On — writes only in the project and /tmp, no network; a way out is asked for each time" },
];

const SANDBOX_NETWORK_CHOICES: readonly SettingChoice[] = [
  { value: "off", label: "Off — no network inside the sandbox (default)" },
  { value: "on", label: "On — sandboxed commands may use the network" },
];

const SUGGEST_CHOICES: readonly SettingChoice[] = [
  { value: "on", label: "On — next steps after a turn, notes on edits, hints while typing (default)" },
  { value: "off", label: "Off — no suggestions" },
];

const JEV_CHOICES: readonly SettingChoice[] = [
  { value: "on", label: "On — judge turns, suggestions and edits when TYPESAFE_API_KEY is set (default)" },
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

const WEB_SEARCH_SETTING_CHOICES: readonly SettingChoice[] = [
  { value: "auto", label: "Automatic — any key set below, else DuckDuckGo, then Stack Overflow (default)" },
  { value: "brave", label: "Brave Search only (needs its key)" },
  { value: "tavily", label: "Tavily only (needs its key)" },
  { value: "searxng", label: "SearXNG only (needs its URL)" },
  { value: "duckduckgo", label: "DuckDuckGo, then Stack Overflow (no key)" },
  { value: "off", label: "Off — no web search without Exa" },
];

const RESUME_CHOICES: readonly SettingChoice[] = [
  { value: "ask", label: "Ask — offer to continue the last chat in this folder (default)" },
  { value: "always", label: "Always — continue the last chat automatically" },
  { value: "never", label: "Never — always start fresh" },
];

const AUTOSAVE_CHOICES: readonly SettingChoice[] = [
  { value: "off", label: "Off — save with ctrl+s (default)" },
  { value: "on", label: "On — save a second after you stop typing" },
];

const REASONING_CHOICES: readonly SettingChoice[] = [
  { value: "auto", label: "Auto (experimental) — lower the effort on routine steps, leave hard ones to the model" },
  { value: "minimal", label: "Minimal — never think more than needed" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High — slowest" },
];

/** Claude is not a model provider but Claude Code run on the person's own subscription (see `engines/claude`). */
const CLAUDE_PROVIDER_ID = "claude";
/** Engines that are the person's own installed agents rather than model providers. */
const OUTSIDE_ENGINE_IDS = [CLAUDE_PROVIDER_ID, "codex"];
const PROVIDER_CHOICES: readonly SettingChoice[] = [
  ...PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDER_INFO[id].label })),
  { value: CLAUDE_PROVIDER_ID, label: "Claude (your subscription, through Claude Code)" },
  { value: "codex", label: "Codex (your ChatGPT plan, through the Codex CLI)" },
];

/**
 * Settings Archymedes may persist. Unknown JSON keys are ignored on read.
 *
 * A `choices` list means the value is picked, not typed. Every one of these was previously a
 * free-text box whose valid answers lived only in the label and the validator — you had to know
 * that Rwanda is `RW` before the field could help you, which is backwards: the list of countries
 * Archymedes can price in is a fact it already holds.
 */
export const SETTING_FIELDS = [
  { key: "ARCHYMEDES_THEME", label: "Theme — colours for the whole CLI (/theme <name> also saves it)", section: "Appearance" }, // choices: the theme section's, via `settingChoices` (ui/settings-menu.ts)
  { key: "ARCHYMEDES_CODE_COLORS", label: "Code colours", choices: CODE_COLOR_CHOICES },
  { key: "ARCHYMEDES_CODE_LINE_NUMBERS", label: "Line numbers in code blocks", choices: SHOW_HIDE_CHOICES },
  { key: "ARCHYMEDES_SIMPLE", label: "Simple mode — quiet start, short help", choices: SIMPLE_CHOICES },
  { key: "ARCHYMEDES_LANGUAGE", label: "Control language", choices: LANGUAGE_CHOICES },
  { key: "ARCHYMEDES_REASONING", label: "Reasoning effort — clear it to leave each model at its own default", choices: REASONING_CHOICES },
  { key: "ARCHYMEDES_RESUME", label: "Continue your last chat at startup", choices: RESUME_CHOICES, section: "Behaviour" },
  { key: "ARCHYMEDES_ENGINE", label: "Engine — what runs your sessions (applies to the next session)", choices: ENGINE_CHOICES },
  { key: "ARCHYMEDES_EDITOR_AUTOSAVE", label: "Auto-save in /edit", choices: AUTOSAVE_CHOICES },
  // Off by default, and the label says what it costs: the deterministic suggestions are free and
  // instant, and this buys two extra project-specific ones for a small model call per turn. A
  // feature that quietly bills a person for a hint is a feature they turn off once and distrust
  // afterwards.
  // The Go engine's suggestions (internal/core/advise): free and on by default, because rules and
  // word matching cost nothing; the model and Jev are the parts that can cost, and have their own rows.
  { key: "ARCHYMEDES_SUGGEST", label: "Suggestions — next steps, notes on edits, hints while typing", choices: SUGGEST_CHOICES },
  { key: "ARCHYMEDES_SUGGEST_MODEL", label: "Ask the model for extra suggestions (a small extra call per turn)", choices: ON_OFF_CHOICES },
  // Three states rather than a switch: looking and installing are different decisions, and the one
  // people want to make separately is whether Archymedes may replace itself without being asked.
  { key: "ARCHYMEDES_AUTO_UPDATE", label: "Automatic updates — install daily by default", choices: AUTO_UPDATE_CHOICES },
  { key: "ARCHYMEDES_TELEMETRY", label: "Install count — one anonymous cue per new version (event, version, OS)", choices: ON_OFF_CHOICES },
  // On by default: writing the tests first is how Friday builds, and the setting is the way out.
  { key: "ARCHYMEDES_TEST_FIRST", label: "Build test first — tests, then code, then static analysis", choices: TEST_FIRST_CHOICES },
  { key: "ARCHYMEDES_JEV", label: "Jev second opinion — verdicts, tool checks, ranked suggestions", choices: JEV_CHOICES },
  { key: "ARCHYMEDES_KEYS", label: "Key bindings, e.g. /diff=alt+d,/wander=off" },
  { key: "ARCHYMEDES_SANDBOX", label: "Command sandbox (Linux, bubblewrap): commands write only to the project and /tmp", choices: SANDBOX_CHOICES },
  { key: "ARCHYMEDES_SANDBOX_NETWORK", label: "Network inside the command sandbox", choices: SANDBOX_NETWORK_CHOICES },
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
  { key: "CLAUDE_MODEL", label: "Claude model (your subscription) — opus, sonnet, haiku or a model id; empty for the default" },
  { key: "CODEX_MODEL", label: "Codex model (your ChatGPT plan) — a model id from Codex's list; empty for Codex's default" },
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
  { key: "ARCHYMEDES_WEB_SEARCH", label: "Web search without Exa", choices: WEB_SEARCH_SETTING_CHOICES },
  { key: "BRAVE_SEARCH_API_KEY", label: "Brave Search API key", secret: true },
  { key: "TAVILY_API_KEY", label: "Tavily API key", secret: true },
  { key: "SEARXNG_URL", label: "SearXNG instance URL (JSON output enabled)", url: true },
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
  ARCHYMEDES_WEB_SEARCH: WEB_SEARCH_CHOICES,
  ARCHYMEDES_EDITOR_AUTOSAVE: ["on", "off"],
  ARCHYMEDES_SUGGEST: ["on", "off"],
  ARCHYMEDES_SUGGEST_MODEL: ["on", "off"],
  ARCHYMEDES_AUTO_UPDATE: ["install", "check", "off"],
  ARCHYMEDES_TELEMETRY: ["on", "off"],
  ARCHYMEDES_REASONING: ["auto", "minimal", "low", "medium", "high"],
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
  if (key === "ARCHYMEDES_PROVIDER" && !isProviderId(value.toLowerCase()) && !OUTSIDE_ENGINE_IDS.includes(value.toLowerCase())) throw new Error(`Choose one of: ${[...PROVIDER_IDS, ...OUTSIDE_ENGINE_IDS].join(", ")}.`);
  if (key === "ARCHYMEDES_PROVIDER") return value.toLowerCase();
  if (key === "ARCHYMEDES_ENGINE" && !["go", "ts"].includes(value.toLowerCase())) throw new Error("Choose go or ts.");
  if (key === "ARCHYMEDES_ENGINE") return value.toLowerCase();
  if ((key === "ARCHYMEDES_JEV" || key === "ARCHYMEDES_TEST_FIRST") && !["on", "off"].includes(value.toLowerCase())) throw new Error("Choose on or off.");
  if (key === "ARCHYMEDES_JEV" || key === "ARCHYMEDES_TEST_FIRST") return value.toLowerCase();
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
    if (!isCurrency(currency)) throw new Error(`${currency} is not a currency Friday can convert to. Leave this empty to use the one your location implies.`);
    return currency;
  }
  return key === "MODEL_PRICE_CURRENCY" ? value.toUpperCase() : value;
}

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
