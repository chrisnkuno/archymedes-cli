import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandRunner } from "./install";

/**
 * The person's own Claude Code: where it is, whether they are signed in, and the environment it
 * runs in.
 *
 * Archymedes never sees a Claude credential. Signing in happens in Claude Code (`claude auth
 * login`, Anthropic's own flow), and the only thing read back is `claude auth status`'s answer to
 * "signed in, and how" — not the account's email or organisation, which it also prints.
 */

/** Where Claude Code's installers put it, after `ARCHYMEDES_CLAUDE_PATH` and the PATH. */
export function findClaude(
  environment: Record<string, string | undefined>,
  options: { exists?: (file: string) => boolean; home?: string; platform?: NodeJS.Platform } = {},
): string | undefined {
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const override = environment.ARCHYMEDES_CLAUDE_PATH?.trim();
  if (override) return exists(override) ? override : undefined;
  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const directories = [
    ...(environment.PATH ?? environment.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
  ];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

export type ClaudeAuth = {
  loggedIn: boolean;
  /** "claude.ai" for a subscription; "apiKey"/"console" when Claude Code bills an API key. */
  authMethod?: string;
  /** "pro", "max", "team", "enterprise"; absent for API billing. */
  subscriptionType?: string;
  /** Why the status could not be read, when it could not. */
  error?: string;
};

/** `claude auth status --json`, reduced to the three fields this needs. */
export async function claudeAuth(executable: string, environment: Record<string, string | undefined>, run: CommandRunner = runCommand): Promise<ClaudeAuth> {
  // In the environment Claude Code will run in, so the answer is about the billing it will use.
  const { code, output } = await run(executable, ["auth", "status", "--json"], { timeoutMs: 15_000, env: claudeEnvironment(environment) });
  return parseAuthStatus(code, output);
}

export function parseAuthStatus(code: number | null, output: string): ClaudeAuth {
  const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    return {
      loggedIn: value.loggedIn === true,
      ...(typeof value.authMethod === "string" ? { authMethod: value.authMethod } : {}),
      ...(typeof value.subscriptionType === "string" ? { subscriptionType: value.subscriptionType } : {}),
    };
  } catch {
    return { loggedIn: false, error: code === null ? output.trim() || "claude did not start" : `claude auth status said: ${output.trim().split("\n").at(-1) ?? code}` };
  }
}

/**
 * The environment Claude Code runs in: this process's own, minus `ANTHROPIC_API_KEY`.
 *
 * With that variable set, Claude Code bills the key instead of the subscription the person signed
 * in with, and says so nowhere a person would look. `ARCHYMEDES_CLAUDE_BILLING=api` keeps it, for
 * someone who wants Claude Code on their API key. The settings-file keys Archymedes holds for its
 * other providers are never added: Claude Code's shell commands would see them.
 */
export function claudeEnvironment(processEnvironment: Record<string, string | undefined>): Record<string, string | undefined> {
  const environment = { ...processEnvironment };
  if (environment.ARCHYMEDES_CLAUDE_BILLING?.trim().toLowerCase() !== "api") delete environment.ANTHROPIC_API_KEY;
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = "archymedes";
  return environment;
}
