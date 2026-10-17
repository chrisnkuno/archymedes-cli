import { loadSettings, mergedEnvironment, saveSettings, type ArchymedesSettings } from "../../platform/settings";
import type { ProviderOverview } from "../acp-setup";
import { claudeAuth, claudeEnvironment, findClaude, type ClaudeAuth } from "./executable";
import { installSdk, type CommandRunner } from "./install";
import { findSdk, loadSdk, type ClaudeSdk } from "./sdk";
import { CLAUDE_LABEL, CLAUDE_PROVIDER } from "./identity";

/**
 * Claude as one of the Providers app's rows, and the steps that make it ready.
 *
 * Ready means three things on this machine: Claude Code is installed, the person is signed in to
 * it, and Anthropic's Agent SDK is installed for Archymedes to drive it with. Connecting checks all
 * three and installs the SDK when it is the only thing missing; signing in is Claude Code's own
 * flow (`claude auth login`), which the interface runs in the terminal for the person.
 */

export const CLAUDE_INSTALL_URL = "https://code.claude.com/docs/en/setup";
export const CLAUDE_LOGIN_ARGS = ["auth", "login"];

/** Claude Code's model aliases, offered until a session has asked Claude Code for its own list. */
export const CLAUDE_MODEL_ALIASES = ["default", "opus", "sonnet", "haiku"];

export type ClaudeReadiness =
  | { ready: true; executable: string; entry: string; auth: ClaudeAuth }
  | { ready: false; missing: string; executable?: string; auth?: ClaudeAuth; needs: "claude" | "sign-in" | "sdk" };

export type BackendDependencies = {
  /** The agent's environment: settings merged over the process's. */
  environment: Record<string, string | undefined>;
  processEnvironment: Record<string, string | undefined>;
  run?: CommandRunner;
  now?: () => number;
  /** Where to look for Claude Code's own install folders (~/.local/bin, ~/.claude/local); the home folder by default. */
  home?: string;
};

/** `claude auth status` costs most of a second; the Providers app asks often. */
const AUTH_TTL_MS = 30_000;
let authCache: { executable: string; at: number; auth: ClaudeAuth } | undefined;

export async function claudeReadiness(deps: BackendDependencies, options: { fresh?: boolean } = {}): Promise<ClaudeReadiness> {
  const executable = findClaude(deps.processEnvironment, deps.home ? { home: deps.home } : {});
  if (!executable) return { ready: false, needs: "claude", missing: `Claude Code installed (${CLAUDE_INSTALL_URL})` };
  const now = (deps.now ?? Date.now)();
  let auth = authCache?.executable === executable && now - authCache.at < AUTH_TTL_MS && !options.fresh ? authCache.auth : undefined;
  if (!auth) {
    auth = await claudeAuth(executable, deps.processEnvironment, deps.run);
    authCache = { executable, at: now, auth };
  }
  if (!auth.loggedIn) return { ready: false, needs: "sign-in", executable, auth, missing: "signing in to Claude (claude auth login)" };
  const entry = findSdk(deps.environment);
  if (!entry) return { ready: false, needs: "sdk", executable, auth, missing: "Anthropic's Agent SDK (installed when you connect)" };
  return { ready: true, executable, entry, auth };
}

/** Whether new sessions would start on Claude: chosen as the default, and present (sign-in is checked on open). */
export function claudeIsDefault(environment: Record<string, string | undefined>): boolean {
  return environment.ARCHYMEDES_PROVIDER?.trim().toLowerCase() === CLAUDE_PROVIDER;
}

export function claudeModel(environment: Record<string, string | undefined>): string {
  return environment.CLAUDE_MODEL?.trim() || "default";
}

/** Claude's row in `_archymedes/providers`. `login` is the command the interface runs to sign in. */
export async function claudeOverview(deps: BackendDependencies): Promise<ProviderOverview & { login?: string[]; note?: string }> {
  const readiness = await claudeReadiness(deps);
  return {
    id: CLAUDE_PROVIDER as ProviderOverview["id"],
    label: CLAUDE_LABEL,
    configured: readiness.ready,
    missing: readiness.ready ? [] : [readiness.missing],
    keyUrl: readiness.ready || readiness.needs !== "claude" ? "" : CLAUDE_INSTALL_URL,
    model: claudeModel(deps.environment),
    isDefault: claudeIsDefault(deps.environment),
    fields: [],
    ...(readiness.executable && !readiness.ready && readiness.needs === "sign-in" ? { login: [readiness.executable, ...CLAUDE_LOGIN_ARGS] } : {}),
    ...(planNote(readiness.auth) ? { note: planNote(readiness.auth) } : {}),
  };
}

/** What signing in gave: a plan is used as the plan; an API key is said out loud, since it is billed per token. */
function planNote(auth: ClaudeAuth | undefined): string | undefined {
  if (!auth?.loggedIn) return undefined;
  if (auth.subscriptionType) return `Signed in with Claude ${capitalize(auth.subscriptionType)}: turns use your plan's limits.`;
  if (auth.authMethod && auth.authMethod !== "claude.ai") return `Claude Code is signed in with an API key (${auth.authMethod}): turns are billed per token.`;
  return undefined;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `_archymedes/providers/connect` for Claude: checks it is ready, installing the SDK if that is all
 * that is missing. Nothing is saved: the person's Claude sign-in belongs to Claude Code.
 */
export async function connectClaude(deps: BackendDependencies): Promise<{ ok: true; file: string; models: string[]; note?: string } | { ok: false; error: string }> {
  let readiness = await claudeReadiness(deps, { fresh: true });
  if (!readiness.ready && readiness.needs === "sdk") {
    const installed = await installSdk(deps.environment, deps.run);
    if (!installed.ok) return { ok: false, error: installed.error };
    readiness = await claudeReadiness(deps);
  }
  if (!readiness.ready) {
    const how = readiness.needs === "claude" ? `Install Claude Code first: ${CLAUDE_INSTALL_URL}` : "Sign in to Claude first: enter runs `claude auth login`, Claude Code's own sign-in.";
    return { ok: false, error: how };
  }
  const note = planNote(readiness.auth);
  return { ok: true, file: "", models: claudeModels(), ...(note ? { note } : {}) };
}

/** Models a session has learned from Claude Code (`supportedModels`), else the aliases. */
let learnedModels: string[] | undefined;

export function claudeModels(): string[] {
  return learnedModels && learnedModels.length > 0 ? ["default", ...learnedModels.filter((model) => model !== "default")] : [...CLAUDE_MODEL_ALIASES];
}

export function learnClaudeModels(models: readonly string[]): void {
  learnedModels = models.filter((model) => typeof model === "string" && model.trim() !== "");
}

/** Remembers the Claude model for new sessions (`CLAUDE_MODEL`); "default" clears it. */
export async function rememberClaudeModel(model: string, deps: BackendDependencies & { load?: () => Promise<ArchymedesSettings>; save?: (settings: ArchymedesSettings) => Promise<string> }): Promise<{ ok: boolean; error?: string }> {
  const current = await (deps.load ?? (() => loadSettings(deps.processEnvironment)))();
  const next: ArchymedesSettings = { ...current };
  if (!model.trim() || model.trim() === "default") delete next.CLAUDE_MODEL;
  else next.CLAUDE_MODEL = model.trim();
  await (deps.save ?? ((settings: ArchymedesSettings) => saveSettings(settings, deps.processEnvironment)))(next);
  Object.assign(deps.environment, mergedEnvironment(next, deps.processEnvironment));
  if (!next.CLAUDE_MODEL) delete deps.environment.CLAUDE_MODEL;
  return { ok: true };
}

export type ClaudeRuntime = {
  sdk: ClaudeSdk;
  executable: string;
  environment: Record<string, string | undefined>;
  /** Whether the person is signed in, still being asked: a session starts Claude Code meanwhile. */
  signedIn: Promise<ClaudeAuth>;
};

/**
 * Everything a Claude session needs to start, or why it cannot. The sign-in check (most of a
 * second) is left running for the caller to await alongside starting Claude Code, not before it.
 */
export async function claudeRuntime(deps: BackendDependencies): Promise<ClaudeRuntime | { error: string }> {
  const executable = findClaude(deps.processEnvironment, deps.home ? { home: deps.home } : {});
  const entry = findSdk(deps.environment);
  if (!executable || !entry) {
    const readiness = await claudeReadiness(deps);
    return { error: `Claude is not ready: it needs ${readiness.ready ? "Anthropic's Agent SDK" : readiness.missing}. Open Providers (alt+p) and choose Claude.` };
  }
  try {
    const sdk = await loadSdk(entry);
    const signedIn = claudeReadiness(deps).then((readiness) => readiness.auth ?? { loggedIn: false });
    return { sdk, executable, environment: claudeEnvironment(deps.processEnvironment), signedIn };
  } catch (error) {
    return { error: `Anthropic's Agent SDK did not load (${error instanceof Error ? error.message : String(error)}). Reconnect Claude in Providers to reinstall it.` };
  }
}
