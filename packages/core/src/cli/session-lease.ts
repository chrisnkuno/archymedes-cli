import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionDirectory } from "./session";

/**
 * Which terminal has a session open.
 *
 * Every terminal runs its own agent process, but they share the project's session files. Without
 * this, `--resume latest` in a second terminal opened the session the first one was still in: two
 * processes then carried the same conversation and the same standing approvals, and the second to
 * save lost its turn to a revision conflict. A lease is a small file beside the session naming the
 * process that holds it; a session someone else holds is not resumed but copied (see
 * `acp-session.ts`), so each terminal keeps its own context and its own approvals.
 *
 * A lease never outlives its process in effect: on the same machine a holder whose pid is gone is
 * stale at once; from another machine (a shared checkout) the holder refreshes the file's time and
 * goes stale when it stops. Released on close, and on exit for a process that never closed it.
 */

export type LeaseHolder = { pid: number; host: string; token: string; since: number };

export type SessionLease = {
  readonly id: string;
  release(): Promise<void>;
};

export type LeaseDependencies = {
  pid?: number;
  host?: string;
  now?: () => number;
  /** Whether a process on this machine is running. */
  isAlive?: (pid: number) => boolean;
  /** How often a holder refreshes its lease; 0 never (tests). */
  heartbeatMs?: number;
};

/** A lease from another machine not refreshed for this long is abandoned. */
export const LEASE_STALE_MS = 3 * 60_000;
const HEARTBEAT_MS = 60_000;
/** A reclaim of a stale lease takes milliseconds; one this old was left by a process that died in it. */
const RECLAIM_ABANDONED_MS = 10_000;

export function leaseFile(root: string, id: string): string {
  return path.join(sessionDirectory(root), `${id}.lease`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else, which is still a holder.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseHolder(text: string): LeaseHolder | null {
  try {
    const value = JSON.parse(text) as Partial<LeaseHolder>;
    if (!Number.isSafeInteger(value.pid) || typeof value.host !== "string" || typeof value.token !== "string") return null;
    return { pid: value.pid!, host: value.host, token: value.token, since: typeof value.since === "number" ? value.since : 0 };
  } catch {
    return null; // a torn or foreign file holds nothing
  }
}

/** The holder named in a lease file, if it is still holding. */
async function liveHolder(file: string, deps: LeaseDependencies): Promise<{ holder: LeaseHolder | null; present: boolean; text: string }> {
  const [text, stat] = await Promise.all([fs.readFile(file, "utf8").catch(() => null), fs.stat(file).catch(() => null)]);
  if (text === null || !stat) return { holder: null, present: false, text: "" };
  const holder = parseHolder(text);
  if (!holder) return { holder: null, present: true, text };
  const host = deps.host ?? os.hostname();
  const alive = holder.host === host
    ? (deps.isAlive ?? processAlive)(holder.pid)
    : (deps.now ?? Date.now)() - stat.mtimeMs < LEASE_STALE_MS;
  return { holder: alive ? holder : null, present: true, text };
}

/** Who holds session `id`, or null when nobody does. */
export async function sessionHolder(root: string, id: string, deps: LeaseDependencies = {}): Promise<LeaseHolder | null> {
  return (await liveHolder(leaseFile(root, id), deps)).holder;
}

// Leases this process holds, released synchronously if it exits without closing them.
const held = new Map<string, string>();
let exitHookInstalled = false;

function releaseOnExit(): void {
  for (const [file, token] of held) {
    try {
      if (parseHolder(readFileSync(file, "utf8"))?.token === token) unlinkSync(file);
    } catch {
      // Already gone, or the directory is: there is nothing left to release.
    }
  }
  held.clear();
}

/**
 * Takes the lease on session `id`, or says who has it. A stale lease (its process gone) is taken
 * over; of two processes reclaiming the same stale lease at once, one gets it.
 */
export async function acquireSessionLease(root: string, id: string, deps: LeaseDependencies = {}): Promise<{ lease: SessionLease } | { heldBy: LeaseHolder }> {
  const file = leaseFile(root, id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const holder: LeaseHolder = { pid: deps.pid ?? process.pid, host: deps.host ?? os.hostname(), token: randomUUID(), since: (deps.now ?? Date.now)() };
  // Taking a lease is an exclusive create, which only one process can win. Removing a stale one is
  // done by one process at a time (the `.reclaim` directory, made atomically), which re-reads the
  // lease first: a process that judged it stale a moment ago may find it already replaced by a live
  // one. Without that, two reclaimers could each remove what the other had just created.
  const reclaim = `${file}.reclaim`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(holder), "utf8");
      } finally {
        await handle.close();
      }
      return { lease: grant(id, file, holder, deps) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = await liveHolder(file, deps);
    if (current.holder) return { heldBy: current.holder };
    if (!current.present) continue; // released meanwhile: try again
    const reclaiming = await fs.mkdir(reclaim).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      return false;
    });
    if (reclaiming) {
      try {
        const again = await liveHolder(file, deps);
        if (again.holder) return { heldBy: again.holder };
        if (again.present) await fs.rm(file, { force: true });
      } finally {
        await fs.rmdir(reclaim).catch(() => undefined); // removed as abandoned by another: nothing to undo
      }
      continue;
    }
    // Someone else is reclaiming it. Wait for them; a reclaim abandoned by a crash ages out.
    const started = await fs.stat(reclaim).catch(() => null);
    if (started && (deps.now ?? Date.now)() - started.mtimeMs > RECLAIM_ABANDONED_MS) await fs.rmdir(reclaim).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const last = await sessionHolder(root, id, deps);
  if (last) return { heldBy: last };
  throw new Error(`Could not take the lease on session ${id}`);
}

function grant(id: string, file: string, holder: LeaseHolder, deps: LeaseDependencies): SessionLease {
  held.set(file, holder.token);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", releaseOnExit);
  }
  const every = deps.heartbeatMs ?? HEARTBEAT_MS;
  const heartbeat = every > 0 ? setInterval(() => {
    const now = new Date();
    fs.utimes(file, now, now).catch(() => undefined); // gone: release or a removed project; nothing to keep fresh
  }, every) : undefined;
  heartbeat?.unref();
  let released = false;
  return {
    id,
    async release() {
      if (released) return;
      released = true;
      if (heartbeat) clearInterval(heartbeat);
      held.delete(file);
      const current = parseHolder(await fs.readFile(file, "utf8").catch(() => ""));
      // Only our own: a lease taken over after ours went stale belongs to its new holder.
      if (current?.token === holder.token) await fs.rm(file, { force: true });
    },
  };
}
