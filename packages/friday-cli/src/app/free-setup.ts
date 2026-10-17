/**
 * Free mode without a dead end, and with its one caveat said out loud.
 *
 * Until the hosted free gateway is deployed (`FREE_GATEWAY_URL` is empty), free mode needs the
 * user's own free OpenRouter key. A fresh install used to print that and exit; in a real terminal
 * it now walks through getting one instead: three lines of why, the URL, a hidden paste, a live
 * check against OpenRouter's key endpoint, and the session starts. A pipe or `--json` run keeps the
 * old message and exit, because there is nobody to answer.
 *
 * The privacy notice is the other half: free endpoints may log or train on what they are sent, and
 * a coding agent sends code. It is shown once — the first time a free turn runs — and remembered in
 * settings, without asking anything.
 */
import { checkOpenRouterKey, describeKeyCheckFailure, type KeyCheck } from "@archymedes/core/providers/openrouter-key-info";
import { maskSetting, SETTING_CANCELLED, type ArchymedesSettings } from "../platform/settings";

export const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

/** The three lines that explain why a key is needed, before the URL. */
export const FREE_SETUP_INTRO = [
  "Free mode runs zero-priced models through OpenRouter and never falls back to a paid one.",
  "Until the hosted Archymedes free gateway is live, it needs your own free OpenRouter key.",
  "Creating one is free and needs no card; Archymedes keeps it in your local settings only.",
] as const;

export const FREE_PRIVACY_NOTICE = "Free models may log your prompts and code; don't send secrets. Use a paid provider for private code.";

/** How many pasted keys OpenRouter may refuse before the setup gives up. */
const MAX_KEY_ATTEMPTS = 3;

export type FreeSetupIo = {
  write(text: string): void;
  /** A hidden prompt; `SETTING_CANCELLED` (Esc), an empty answer or a throw (Ctrl+C/D) cancels. */
  askSecret(question: string): Promise<string>;
  check?(key: string): Promise<KeyCheck>;
  /** Persists the settings and returns the file written. */
  save(settings: ArchymedesSettings): Promise<string>;
  style?: { bold(text: string): string; dim(text: string): string; cyan(text: string): string; red(text: string): string; green(text: string): string };
};

const plain = { bold: (text: string) => text, dim: (text: string) => text, cyan: (text: string) => text, red: (text: string) => text, green: (text: string) => text };

/** What a successful check says about the key, in a few words: `47/50 free requests left today`. */
export function describeKeyAllowance(check: Extract<KeyCheck, { ok: true }>): string | undefined {
  const daily = check.info.freeDailyRequests;
  if (daily?.remaining !== undefined && daily.limit !== undefined) return `${daily.remaining}/${daily.limit} free requests left today`;
  if (daily?.limit !== undefined) return `limit: ${daily.limit} req/day`;
  return undefined;
}

/**
 * The guided setup. Resolves to the settings saved (with the key and `ARCHYMEDES_PROVIDER=free`),
 * or undefined when the person cancelled or OpenRouter refused every key offered.
 */
export async function runFreeModeSetup(current: ArchymedesSettings, io: FreeSetupIo): Promise<ArchymedesSettings | undefined> {
  const style = io.style ?? plain;
  io.write(`\n${style.bold("Free mode setup")}\n`);
  for (const line of FREE_SETUP_INTRO) io.write(`  ${line}\n`);
  io.write(`  Get a key: ${style.cyan(OPENROUTER_KEYS_URL)}\n\n`);
  const check = io.check ?? ((key: string) => checkOpenRouterKey(key));
  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt += 1) {
    let answer: string;
    try {
      answer = await io.askSecret("  OpenRouter API key (Esc or empty cancels): ");
    } catch {
      // Ctrl+C or Ctrl+D while typing: the same as cancelling.
      answer = SETTING_CANCELLED;
    }
    const key = answer === SETTING_CANCELLED ? "" : answer.trim();
    if (!key) {
      io.write(style.dim(`  Free mode setup cancelled. Run archymedes settings to add a key later.\n`));
      return undefined;
    }
    io.write(style.dim(`  Checking ${maskSetting(key)} with OpenRouter…\n`));
    const result = await check(key);
    if (!result.ok && result.reason === "invalid") {
      io.write(`  ${style.red(describeKeyCheckFailure(result))}\n`);
      continue;
    }
    // A network or server failure says nothing about the key itself. Refusing it would make an
    // offline first run a dead end again; the first request reports a bad key clearly enough.
    if (!result.ok) io.write(style.dim(`  ${describeKeyCheckFailure(result)} Saving it anyway; the first request will confirm it.\n`));
    const settings: ArchymedesSettings = { ...current, OPENROUTER_API_KEY: key, ARCHYMEDES_PROVIDER: "free" };
    const file = await io.save(settings);
    const allowance = result.ok ? describeKeyAllowance(result) : undefined;
    io.write(style.green(`  Key saved to ${file}. Free mode is ready${allowance ? ` (${allowance})` : ""}.\n\n`));
    return settings;
  }
  io.write(style.dim("  Free mode setup stopped. Run archymedes settings to add a key later.\n"));
  return undefined;
}

/** Whether the one-time privacy notice still needs showing. */
export function needsFreePrivacyNotice(environment: Record<string, string | undefined>): boolean {
  return environment.ARCHYMEDES_FREE_PRIVACY_ACK?.trim().toLowerCase() !== "yes";
}

/**
 * Shows the privacy notice once and records that it was shown. Never throws and never asks: a
 * settings file that cannot be written means the notice may appear again, not that the turn fails.
 */
export async function showFreePrivacyNoticeOnce(options: {
  environment: Record<string, string | undefined>;
  saved: ArchymedesSettings;
  write(text: string): void;
  save(settings: ArchymedesSettings): Promise<unknown>;
  style?: { yellow(text: string): string };
}): Promise<ArchymedesSettings | undefined> {
  if (!needsFreePrivacyNotice(options.environment)) return undefined;
  options.write(`${options.style ? options.style.yellow(`  ${FREE_PRIVACY_NOTICE}`) : `  ${FREE_PRIVACY_NOTICE}`}\n`);
  options.environment.ARCHYMEDES_FREE_PRIVACY_ACK = "yes";
  const next: ArchymedesSettings = { ...options.saved, ARCHYMEDES_FREE_PRIVACY_ACK: "yes" };
  await options.save(next).catch(() => undefined);
  return next;
}
