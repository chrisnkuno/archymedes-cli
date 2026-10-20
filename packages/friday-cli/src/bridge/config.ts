/**
 * What the bridge is told about its session: where to dial, the secret that proves it is this
 * session's bridge, and the environment the agent runs in.
 *
 * It arrives as a file because the bridge is already running when the session starts: the sandbox
 * template's start command launches it at build time and E2B snapshots the running process, so a
 * new sandbox begins with a bridge that knows nothing. The server then writes this file through the
 * sandbox's file endpoint (plain HTTP, which a Worker can call), and writes it again after every
 * resume with a fresh secret. The bridge reconnects whenever the file's text changes.
 */

export const BRIDGE_CONFIG_PATH = "/etc/friday/session.json";

export type BridgeConfig = {
  /** `wss://…/api/bridge/<sessionId>`; `ws://` only for a local address (tests). */
  url: string;
  secret: string;
  sessionId: string;
  /** Where the agent works: the cloned repository, or an empty workspace. */
  cwd: string;
  /** Added to the agent's environment: the model proxy's address and the session token as its key. */
  env: Record<string, string>;
  /** Small files to put in place before the agent starts (a provider's connection file). See `CONFIG_FILE_ROOT`. */
  files: Array<{ path: string; content: string }>;
};

/**
 * Where a config may ask for a file to be written: under the agent's own configuration folder, and nowhere
 * else. The server that writes the config is trusted, but this is the one thing in the bridge that writes
 * what it is told, so it is held to the one place it is for.
 */
export const CONFIG_FILE_ROOT = ".config/archymedes/";
const MAX_FILES = 4;
const MAX_FILE_CHARS = 16 * 1024;

const LOCAL_URL = /^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//;

/** Parses the config file's text; throws with what is wrong, since a bridge that never connects says nothing else. */
export function parseBridgeConfig(raw: string): BridgeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("session.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("session.json must be an object");
  const { url, secret, sessionId, cwd, env, files } = parsed as Record<string, unknown>;
  if (typeof url !== "string" || !(url.startsWith("wss://") || LOCAL_URL.test(url))) throw new Error("session.json: url must be wss:// (ws:// only for localhost)");
  if (typeof secret !== "string" || secret.length < 16) throw new Error("session.json: secret is missing or too short");
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(sessionId)) throw new Error("session.json: sessionId is missing or malformed");
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new Error("session.json: cwd must be an absolute path");
  const environment: Record<string, string> = {};
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) throw new Error("session.json: env must be an object");
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") throw new Error(`session.json: env.${key} must be a string under a plain name`);
      environment[key] = value;
    }
  }
  const written: BridgeConfig["files"] = [];
  if (files !== undefined) {
    if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error(`session.json: files must be a list of at most ${MAX_FILES}`);
    for (const file of files) {
      const entry = file as { path?: unknown; content?: unknown };
      if (typeof entry?.path !== "string" || typeof entry.content !== "string") throw new Error("session.json: each file needs a path and content, as text");
      if (!entry.path.startsWith(CONFIG_FILE_ROOT) || entry.path.length > 200 || /\.\.|\/\/|[\x00-\x1f\\]/.test(entry.path) || entry.path.endsWith("/")) throw new Error(`session.json: a file may only go under ${CONFIG_FILE_ROOT}`);
      if (entry.content.length > MAX_FILE_CHARS) throw new Error("session.json: a file is too large");
      written.push({ path: entry.path, content: entry.content });
    }
  }
  return { url, secret, sessionId, cwd, env: environment, files: written };
}
