import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Exclusive local ownership with crash recovery. A fully written owner record is published
 * atomically with a hard link. Age never evicts a live writer; stale reclamation is serialized.
 */
type Owner = { token: string; pid: number; host: string; started?: string };

/** The file is held by a process that is still running. Callers that can wait retry on this one error. */
export class OwnershipHeldError extends Error {
  constructor(readonly pid: number) {
    super(`Session is already owned by process ${pid}; close or detach the other writer first.`);
  }
}

async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const boot = await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8");
    return `${boot.trim()}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
  } catch { return undefined; }
}

async function readOwner(file: string): Promise<Owner | null> {
  try {
    const owner = JSON.parse(await fs.readFile(file, "utf8")) as Owner;
    if (!owner || typeof owner.token !== "string" || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.host !== "string") {
      throw new Error(`Invalid ownership record: ${file}`);
    }
    return owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function isAlive(owner: Owner): Promise<boolean> {
  if (owner.host !== os.hostname()) return true; // Never evict a writer on a different host.
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  const started = await processStart(owner.pid);
  return !owner.started || !started || owner.started === started;
}

export async function acquireFileOwnership(file: string, depth = 0): Promise<() => Promise<void>> {
  if (depth > 8) throw new Error(`Ownership recovery requires inspection: ${file}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const owner: Owner = { token: randomUUID(), pid: process.pid, host: os.hostname(), started: await processStart(process.pid) };
  const candidate = `${file}.${owner.token}.tmp`;
  const handle = await fs.open(candidate, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
  finally { await handle.close(); }
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await fs.link(candidate, file);
        return async () => {
          if ((await readOwner(file))?.token === owner.token) await fs.unlink(file);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const current = await readOwner(file);
      if (!current) continue;
      if (await isAlive(current)) throw new OwnershipHeldError(current.pid);
      // Two contenders must not both unlink a dead owner's file and remove the winner's lock.
      // The guard uses the same crash-safe protocol, including recovery if its own owner died.
      const release = await acquireFileOwnership(`${file}.reap`, depth + 1);
      try {
        if ((await readOwner(file))?.token === current.token) await fs.unlink(file);
      } finally { await release(); }
    }
    throw new Error(`Could not acquire session ownership: ${file}`);
  } finally { await fs.unlink(candidate).catch(() => undefined); }
}
