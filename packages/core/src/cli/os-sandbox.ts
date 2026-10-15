import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A sandbox for the agent's local commands, enforced by the operating system rather than by the
 * model's good behaviour (Codex's workspace-write mode). On Linux, bubblewrap: the whole filesystem
 * read-only, the project and the temporary directory writable, Archymedes's own state read-only
 * inside the project, and no network unless asked for. A command it blocks fails like any other;
 * the agent is told it may ask to run that one command outside, and the person is always asked.
 *
 * Opt in with `ARCHYMEDES_SANDBOX=on` (network with `ARCHYMEDES_SANDBOX_NETWORK=on`). On, but
 * impossible here (not Linux, no bubblewrap, user namespaces off), commands are refused with the
 * reason: a sandbox someone asked for is never silently absent.
 */

export type SandboxPolicy = {
  /** Directories commands may write to; everything else is read-only. */
  writable: string[];
  /** Paths inside a writable directory that stay read-only (Archymedes's own state). */
  readOnly: string[];
  network: boolean;
};

export type CommandSandbox =
  | { state: "off" }
  | { state: "on"; policy: SandboxPolicy }
  | { state: "unavailable"; reason: string };

/** The sandbox a local session's commands run under, from the environment and what this machine can do. */
export function commandSandboxFor(root: string, environment: Record<string, string | undefined>, probe: () => string | undefined = probeBubblewrap): CommandSandbox {
  if (environment.ARCHYMEDES_SANDBOX?.trim().toLowerCase() !== "on") return { state: "off" };
  const unavailable = probe();
  if (unavailable) return { state: "unavailable", reason: unavailable };
  const absolute = path.resolve(root);
  return {
    state: "on",
    policy: {
      writable: [absolute, os.tmpdir()],
      readOnly: [path.join(absolute, ".archymedes")],
      network: environment.ARCHYMEDES_SANDBOX_NETWORK?.trim().toLowerCase() === "on",
    },
  };
}

let probed: string | undefined | null = null;

/** Undefined when bubblewrap can run a command here; otherwise why not. Probed once per process. */
export function probeBubblewrap(): string | undefined {
  if (probed !== null) return probed;
  if (process.platform !== "linux") return (probed = `the sandbox is Linux-only for now (this is ${process.platform})`);
  const result = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "true"], { timeout: 5_000 });
  if (result.error) return (probed = "bubblewrap (bwrap) is not installed: install it (apt install bubblewrap) or set ARCHYMEDES_SANDBOX=off");
  if (result.status !== 0) return (probed = `bubblewrap cannot run here (${result.stderr.toString().trim() || `exit ${result.status}`}); user namespaces may be disabled`);
  return (probed = undefined);
}

/** bubblewrap's arguments for a policy, to be followed by the command's own argv. */
export function bubblewrapArgs(policy: SandboxPolicy, cwd: string): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const directory of policy.writable) args.push("--bind", directory, directory);
  for (const file of policy.readOnly) if (existsSync(file)) args.push("--ro-bind", file, file);
  if (!policy.network) args.push("--unshare-net");
  args.push("--unshare-pid", "--die-with-parent", "--chdir", cwd, "--");
  return args;
}

/**
 * Whether a failure reads like the sandbox's doing: a write outside the writable places, or a
 * network call with no network. A guess from the output, used only to tell the model it may ask.
 */
export function looksSandboxDenied(result: { exitCode: number; stdout: string; stderr: string }): boolean {
  if (result.exitCode === 0) return false;
  return /read-only file system|EROFS|operation not permitted|EPERM|could not resolve host|temporary failure in name resolution|network is unreachable|ENETUNREACH|EAI_AGAIN|getaddrinfo|name or service not known/i.test(`${result.stderr}\n${result.stdout}`);
}

export const SANDBOX_ESCALATION_NOTE = "This may have been blocked by the sandbox (commands write only inside the project and the temporary directory, and have no network). If the command really needs more, call run_command again with escalate: true and say why in your message; the person will be asked to allow that one run outside the sandbox.";

/** For tests: forget the probe. */
export function resetBubblewrapProbe(): void {
  probed = null;
}
