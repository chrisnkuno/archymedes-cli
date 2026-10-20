import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import type { ControlResult } from "./relay";

/**
 * Housekeeping the server asks of the sandbox: clone the repository, make the working branch, push
 * it. Git runs here, as a request over the bridge, because the server cannot run commands in a
 * sandbox (its SDK does not run in Workers) and because the credential then never has to be written
 * anywhere.
 *
 * **The credential.** A token arrives in the request, is handed to the one `git` process through
 * its environment (`GIT_CONFIG_*`, git's own way to pass a config value without a file), and is gone
 * when it exits: not in `.git/config`, not in the remote URL, not in the bridge's own environment.
 * The agent shares this user, so it could read the process's environment during the seconds git
 * runs; what that exposes is a token scoped to one repository that expires within the hour.
 *
 * **The arguments** come from a server we trust but are still checked as if they did not: a name
 * that starts with `-` would be read by git as an option, so every ref and URL is matched against
 * what it may be, and `--` ends options before any path.
 */

export type Exec = (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export type ControlContext = {
  /** The agent's working directory: a clone goes into it, and every other operation runs in it. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  exec?: Exec;
};

const REF = /^(?!-)(?!.*\.\.)(?!.*[\s~^:?*[\\])[A-Za-z0-9._/-]{1,200}$/;
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}?(?:\.git)?$/;
const GIT_TIMEOUT_MS = 10 * 60_000;

const defaultExec: Exec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, [...args], { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr: error && !stderr ? error.message : stderr });
    });
  });

/** `GIT_CONFIG_*` carrying an HTTP header with the token, for GitHub only. */
export function tokenEnvironment(token: string | undefined): NodeJS.ProcessEnv {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Removes the token from anything that is about to be shown to a person. */
function scrub(text: string, token: string | undefined): string {
  let out = text;
  if (token) {
    out = out.split(token).join("***").split(Buffer.from(`x-access-token:${token}`).toString("base64")).join("***");
  }
  return out.trim();
}

export async function runControl(op: string, args: Record<string, unknown>, context: ControlContext): Promise<ControlResult> {
  const exec = context.exec ?? defaultExec;
  const text = (key: string): string | undefined => (typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined);
  const token = text("token");
  const git = async (cwd: string, gitArgs: readonly string[], useToken = false): Promise<{ ok: boolean; out: string }> => {
    const env = { ...context.env, ...(useToken ? tokenEnvironment(token) : {}), GIT_TERMINAL_PROMPT: "0" };
    const result = await exec("git", gitArgs, { cwd, env, timeoutMs: GIT_TIMEOUT_MS });
    return { ok: result.code === 0, out: scrub([result.stdout, result.stderr].filter(Boolean).join("\n"), token) };
  };

  switch (op) {
    case "clone": {
      const url = text("url");
      if (!url || !GITHUB_URL.test(url)) return { ok: false, detail: "clone needs an https://github.com/<owner>/<repo> URL" };
      const branch = text("branch");
      if (branch && !REF.test(branch)) return { ok: false, detail: "that branch name is not allowed" };
      // Into the agent's own directory, which must be empty: a clone never merges with, or
      // overwrites, work that is already there.
      await fs.mkdir(context.cwd, { recursive: true });
      if ((await fs.readdir(context.cwd)).length > 0) return { ok: false, detail: "the workspace is not empty" };
      const cloned = await git(context.cwd, ["clone", ...(branch ? ["--branch", branch] : []), "--", url, "."], true);
      return cloned.ok ? { ok: true, detail: { dir: context.cwd } } : { ok: false, detail: cloned.out };
    }
    case "branch": {
      const name = text("name");
      if (!name || !REF.test(name)) return { ok: false, detail: "that branch name is not allowed" };
      const made = await git(context.cwd, ["checkout", "-b", name]);
      return made.ok ? { ok: true, detail: { branch: name } } : { ok: false, detail: made.out };
    }
    case "push": {
      const branch = text("branch");
      if (!branch || !REF.test(branch)) return { ok: false, detail: "push needs a branch name" };
      if (!token) return { ok: false, detail: "push needs a token" };
      const pushed = await git(context.cwd, ["push", "--set-upstream", "origin", "--", `${branch}:${branch}`], true);
      return pushed.ok ? { ok: true, detail: pushed.out } : { ok: false, detail: pushed.out };
    }
    case "status": {
      const status = await git(context.cwd, ["status", "--porcelain=v1", "--branch"]);
      return status.ok ? { ok: true, detail: status.out } : { ok: false, detail: status.out };
    }
    default:
      return { ok: false, detail: `unknown operation '${op.slice(0, 40)}'` };
  }
}
