import { promises as fs } from "node:fs";
import path from "node:path";
import { eventJournalPath } from "@archymedes/core/cli/protocol";
import { listSessions, sessionDirectory, sessionJournalPath } from "@archymedes/core/cli/session";

/**
 * Deleting a past chat, completely.
 *
 * A session is more than its snapshot: there is the snapshot (`sessions/<id>.json`), its step
 * journal (`sessions/<id>.steps.jsonl`), the event journal (`events/<id>.jsonl`), a hosted-recovery
 * batch (`recovery/<id>.json`), and two read models built from those — the native index
 * (`state/index-v1.sqlite3`, which drops any session whose files are gone on its next rebuild) and
 * the event projection (`projection.db`, cleared here). Removing only the snapshot would leave the
 * chat searchable and, worse, listed again the next time anything replayed the journal.
 *
 * Everything lives under this project's own `.archymedes`, so a deletion can never reach another
 * project's chats — and the session currently open is refused, because deleting the file under a
 * live session would only have it written straight back at the end of the next turn.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type DeleteOutcome = { deleted: true } | { deleted: false; reason: string };

async function removeIfPresent(file: string): Promise<boolean> {
  try {
    await fs.rm(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Clears the session's rows from the event projection, if this project has one. Never creates it. */
async function clearProjection(root: string, id: string): Promise<void> {
  const file = path.join(root, ".archymedes", "projection.db");
  const exists = await fs.access(file).then(() => true, () => false);
  if (!exists) return;
  try {
    const { SessionProjection } = await import("@archymedes/core/cli/projection");
    const projection = await SessionProjection.open(root);
    try {
      // The journal is already gone, so a rebuild of this session writes nothing back: it only clears.
      await projection.rebuild(id);
    } finally {
      projection.close();
    }
  } catch {
    // A cache. If it cannot be opened here it is rebuilt from the (now absent) journal later.
  }
}

export async function deleteSession(root: string, id: string, options: { activeId?: string } = {}): Promise<DeleteOutcome> {
  if (!SAFE_ID.test(id)) return { deleted: false, reason: `"${id}" is not a session id.` };
  if (id === options.activeId) return { deleted: false, reason: "That is the chat you are in — it can't be deleted while it is open. Use /clear to start a fresh one first." };
  const removed = await Promise.all([
    removeIfPresent(path.join(sessionDirectory(root), `${id}.json`)),
    removeIfPresent(sessionJournalPath(root, id)),
    removeIfPresent(eventJournalPath(root, id)),
    removeIfPresent(path.join(root, ".archymedes", "recovery", `${id}.json`)),
  ]);
  if (!removed.some(Boolean)) return { deleted: false, reason: `No session ${id} in this project.` };
  await clearProjection(root, id);
  return { deleted: true };
}

/** Every chat in this project except the open one. Returns how many went. */
export async function deleteAllSessions(root: string, options: { activeId?: string } = {}): Promise<{ deleted: number }> {
  const all = await listSessions(root, Number.MAX_SAFE_INTEGER);
  let deleted = 0;
  for (const session of all) {
    if (session.id === options.activeId) continue;
    const outcome = await deleteSession(root, session.id, options);
    if (outcome.deleted) deleted += 1;
  }
  return { deleted };
}
