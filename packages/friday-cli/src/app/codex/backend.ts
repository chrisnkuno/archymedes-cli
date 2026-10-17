import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, mergedEnvironment, saveSettings, type ArchymedesSettings } from "../../platform/settings";
import type { ProviderOverview } from "../acp-setup";
import { runCommand, type CommandRunner } from "../claude/install";
import { CODEX_LABEL, CODEX_PROVIDER } from "./identity";

/**
 * Codex as one of the Providers app's rows: the person's own Codex CLI, signed in with their
 * ChatGPT plan (or an API key they gave Codex). Archymedes drives `codex app-server` and never sees
 * a credential: signing in is Codex's own `codex login`, which the interface runs in the terminal.
 */

export const CODEX_INSTALL_URL = "https://developers.openai.com/codex/cli";
export const CODEX_LOGIN_ARGS = ["login"];

export type CodexDependencies = {
  environment: Record<string, string | undefined>;
  processEnvironment: Record<string, string | undefined>;
  run?: CommandRunner;
  now?: () => number;
  home?: string;
};

export type CodexAuth = { loggedIn: boolean; method?: "chatgpt" | "apiKey"; error?: string };

export type CodexReadiness =
  | { ready: true; executable: string; auth: CodexAuth }
  | { ready: false; missing: string; executable?: string; auth?: CodexAuth; needs: "codex" | "sign-in" };

/** `ARCHYMEDES_CODEX_PATH`, else `codex` on the PATH or where npm and Homebrew put it. */
export function findCodex(
  environment: Record<string, string | undefined>,
  options: { exists?: (file: string) => boolean; home?: string; platform?: NodeJS.Platform } = {},
): string | undefined {
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const override = environment.ARCHYMEDES_CODEX_PATH?.trim();
  if (override) return exists(override) ? override : undefined;
  const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  const directories = [
    ...(environment.PATH ?? environment.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean),
    path.join(options.home ?? os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `codex login status`: "Logged in using ChatGPT" or "… an API key"; anything else is signed out. */
export function parseLoginStatus(code: number | null, output: string): CodexAuth {
  const text = output.trim();
  if (code === 0 && /logged in/i.test(text)) return { loggedIn: true, method: /api key/i.test(text) ? "apiKey" : "chatgpt" };
  if (code === null) return { loggedIn: false, error: text || "codex did not start" };
  return { loggedIn: false };
}

const AUTH_TTL_MS = 30_000;
let authCache: { executable: string; at: number; auth: CodexAuth } | undefined;

export async function codexReadiness(deps: CodexDependencies, options: { fresh?: boolean } = {}): Promise<CodexReadiness> {
  const executable = findCodex(deps.processEnvironment, deps.home ? { home: deps.home } : {});
  if (!executable) return { ready: false, needs: "codex", missing: `Codex installed (${CODEX_INSTALL_URL})` };
  const now = (deps.now ?? Date.now)();
  let auth = authCache?.executable === executable && now - authCache.at < AUTH_TTL_MS && !options.fresh ? authCache.auth : undefined;
  if (!auth) {
    const { code, output } = await (deps.run ?? runCommand)(executable, ["login", "status"], { timeoutMs: 15_000, env: codexEnvironment(deps.processEnvironment) });
    auth = parseLoginStatus(code, output);
    authCache = { executable, at: now, auth };
  }
  if (!auth.loggedIn) return { ready: false, needs: "sign-in", executable, auth, missing: "signing in to Codex (codex login)" };
  return { ready: true, executable, auth };
}

/** Codex's environment: the person's, without Archymedes's own OpenAI key (Codex has its sign-in). */
export function codexEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = { ...environment };
  if (environment.ARCHYMEDES_CODEX_BILLING?.trim().toLowerCase() !== "api") delete env.OPENAI_API_KEY;
  return env;
}

export function codexIsDefault(environment: Record<string, string | undefined>): boolean {
  return environment.ARCHYMEDES_PROVIDER?.trim().toLowerCase() === CODEX_PROVIDER;
}

export function codexModel(environment: Record<string, string | undefined>): string {
  return environment.CODEX_MODEL?.trim() || "default";
}

/** Codex's row in `_archymedes/providers`. `login` is the command the interface runs to sign in. */
export async function codexOverview(deps: CodexDependencies): Promise<ProviderOverview & { login?: string[]; note?: string; about: string }> {
  const readiness = await codexReadiness(deps);
  const note = readiness.auth?.loggedIn
    ? readiness.auth.method === "apiKey" ? "Codex is signed in with an API key: turns are billed per token." : "Signed in with ChatGPT: turns use your plan's Codex limits."
    : undefined;
  return {
    id: CODEX_PROVIDER as ProviderOverview["id"],
    label: CODEX_LABEL,
    configured: readiness.ready,
    missing: readiness.ready ? [] : [readiness.missing],
    keyUrl: readiness.ready || readiness.needs !== "codex" ? "" : CODEX_INSTALL_URL,
    model: codexModel(deps.environment),
    isDefault: codexIsDefault(deps.environment),
    fields: [],
    about: "Runs your own Codex on your ChatGPT plan. Signing in is Codex's own; Archymedes never sees your account.",
    ...(readiness.executable && !readiness.ready && readiness.needs === "sign-in" ? { login: [readiness.executable, ...CODEX_LOGIN_ARGS] } : {}),
    ...(note ? { note } : {}),
  };
}

export async function connectCodex(deps: CodexDependencies): Promise<{ ok: true; file: string; models: string[]; note?: string } | { ok: false; error: string }> {
  const readiness = await codexReadiness(deps, { fresh: true });
  if (!readiness.ready) {
    return { ok: false, error: readiness.needs === "codex" ? `Install Codex first: ${CODEX_INSTALL_URL}` : "Sign in to Codex first: enter runs `codex login`, Codex's own sign-in." };
  }
  return { ok: true, file: "", models: codexModels() };
}

/** Models a session has learned from Codex (`model/list`), else Codex's own default. */
let learnedModels: string[] | undefined;

export function codexModels(): string[] {
  return learnedModels && learnedModels.length > 0 ? ["default", ...learnedModels.filter((model) => model !== "default")] : ["default"];
}

export function learnCodexModels(models: readonly string[]): void {
  learnedModels = models.filter((model) => typeof model === "string" && model.trim() !== "");
}

/** Remembers the Codex model for new sessions (`CODEX_MODEL`); "default" clears it. */
export async function rememberCodexModel(model: string, deps: CodexDependencies & { load?: () => Promise<ArchymedesSettings>; save?: (settings: ArchymedesSettings) => Promise<string> }): Promise<{ ok: boolean }> {
  const current = await (deps.load ?? (() => loadSettings(deps.processEnvironment)))();
  const next: ArchymedesSettings = { ...current };
  if (!model.trim() || model.trim() === "default") delete next.CODEX_MODEL;
  else next.CODEX_MODEL = model.trim();
  await (deps.save ?? ((settings: ArchymedesSettings) => saveSettings(settings, deps.processEnvironment)))(next);
  Object.assign(deps.environment, mergedEnvironment(next, deps.processEnvironment));
  if (!next.CODEX_MODEL) delete deps.environment.CODEX_MODEL;
  return { ok: true };
}

/** Codex in the provider list, after Claude (or after free when Claude is absent). */
export function withCodex<T extends { id: string }>(providers: T[], codex: T): T[] {
  const after = Math.max(providers.findIndex((provider) => provider.id === "claude"), providers.findIndex((provider) => provider.id === "free"));
  return [...providers.slice(0, after + 1), codex, ...providers.slice(after + 1)];
}

export { CODEX_LABEL, CODEX_PROVIDER };

type ModelListing = {
  choices: Array<Record<string, unknown> & { provider: string }>;
  unconfigured: Array<{ provider: string; label: string; missing: string[] }>;
};

/** The model picker's list, with Codex's models: usable once Codex is ready, shown (locked) before. */
export function withCodexModels<T extends ModelListing>(listing: T, codex: ProviderOverview): T {
  const preferred = codex.model || "default";
  const choices = codexModels().map((model) => ({
    provider: CODEX_PROVIDER, providerLabel: CODEX_LABEL, model, isDefault: model === preferred, live: false,
    price: "your ChatGPT plan", free: false, locked: !codex.configured, missing: codex.missing, small: false,
  }));
  const ready = listing.choices.filter((choice) => choice.locked !== true);
  const locked = listing.choices.filter((choice) => choice.locked === true);
  return {
    ...listing,
    choices: codex.configured ? [...ready, ...choices, ...locked] : [...ready, ...locked, ...choices],
    unconfigured: codex.configured ? listing.unconfigured : [...listing.unconfigured, { provider: CODEX_PROVIDER, label: CODEX_LABEL, missing: codex.missing }],
  };
}

/** First-run setup: Codex as the default provider is usable when it is ready, with no model provider configured. */
export async function codexSetupStatus<T extends { configured: boolean; reason?: string }>(status: T, requested: { provider?: string }, deps: CodexDependencies): Promise<T> {
  const wanted = requested.provider ? requested.provider === CODEX_PROVIDER : codexIsDefault(deps.environment);
  if (!wanted) return status;
  const readiness = await codexReadiness(deps);
  if (readiness.ready) return { ...status, configured: true, reason: undefined };
  return { ...status, configured: false, reason: `Codex needs ${readiness.missing}.` };
}
