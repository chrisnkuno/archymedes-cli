import { randomUUID } from "node:crypto";
import path from "node:path";
import { CheckpointStore, runGit, type GitRunner } from "./checkpoints";
import { newSessionId, saveSession, type SessionRecord } from "./session";

/**
 * `/fork`: the conversation so far, copied into a new session that goes its own way; the original
 * stays exactly as it was and can still be resumed. The copy's checkpoints get refs of their own,
 * so rewinding works in either one and deleting one session's refs never takes the other's trees.
 *
 * Claude Code's own session id is not carried: two Archymedes sessions continuing one Claude
 * conversation would interleave in it. The fork tells Claude what was said instead.
 */
export async function forkSession(record: SessionRecord, git: GitRunner = runGit): Promise<SessionRecord> {
  const now = Date.now();
  const fork: SessionRecord = {
    ...structuredClone(record),
    id: newSessionId(new Date(now)),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    title: forkTitle(record.title),
  };
  delete fork.integrity;
  delete fork.claudeSession;
  delete fork.hostedRecoveryBatchId;
  if (fork.checkpoints?.length) {
    const store = new CheckpointStore(fork.root, path.join(fork.root, ".archymedes", `fork-index-${randomUUID()}`), git, () => fork.id);
    await store.load(fork.checkpoints);
    fork.checkpoints = store.list();
  }
  await saveSession(fork);
  return fork;
}

export function forkTitle(title: string): string {
  return title.endsWith(" (fork)") ? title : `${title} (fork)`;
}
