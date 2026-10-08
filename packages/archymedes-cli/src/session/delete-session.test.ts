import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eventJournalPath } from "@archymedes/core/cli/protocol";
import { listSessions, loadSession, saveSession, sessionDirectory, type SessionRecord } from "@archymedes/core/cli/session";
import { findRecentSession } from "../app/resume-offer";
import { deleteAllSessions, deleteSession } from "./delete-session";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-delete-"));
  roots.push(root);
  return root;
}

function record(root: string, id: string, title: string, updatedAt = Date.now()): SessionRecord {
  return { schemaVersion: 2, revision: 0, id, createdAt: updatedAt, updatedAt, root, title, messages: [{ role: "user", content: title }], approvals: {}, totalRwf: 0 };
}

const A = "20261001T101010Z-aaaaaa";
const B = "20261002T101010Z-bbbbbb";

describe("deleting a past chat", () => {
  it("removes the snapshot and its journals, so it is gone from every list", async () => {
    const root = await project();
    await saveSession(record(root, A, "fix the parser"));
    await saveSession(record(root, B, "add a health check"));
    const events = eventJournalPath(root, A);
    await fs.mkdir(path.dirname(events), { recursive: true });
    await fs.writeFile(events, "");

    expect(await deleteSession(root, A, { activeId: B })).toEqual({ deleted: true });
    expect(await loadSession(root, A)).toBeNull();
    await expect(fs.access(events)).rejects.toThrow();
    expect((await listSessions(root)).map((session) => session.id)).toEqual([B]);
  });

  it("refuses the chat that is open, and says so", async () => {
    const root = await project();
    await saveSession(record(root, A, "fix the parser"));
    const outcome = await deleteSession(root, A, { activeId: A });
    expect(outcome.deleted).toBe(false);
    expect(outcome.deleted === false && outcome.reason).toMatch(/chat you are in/);
    expect(await loadSession(root, A)).not.toBeNull();
  });

  it("reports an unknown or unsafe id instead of pretending", async () => {
    const root = await project();
    expect((await deleteSession(root, B)).deleted).toBe(false);
    expect((await deleteSession(root, "../escape")).deleted).toBe(false);
  });

  it("deletes everything else at once, keeping the open chat", async () => {
    const root = await project();
    await saveSession(record(root, A, "fix the parser"));
    await saveSession(record(root, B, "add a health check"));
    expect(await deleteAllSessions(root, { activeId: B })).toEqual({ deleted: 1 });
    expect((await listSessions(root)).map((session) => session.id)).toEqual([B]);
  });
});

describe("chats stay in their own project", () => {
  it("never lists or offers a chat recorded against another project, even if its file is copied in", async () => {
    const here = await project();
    const elsewhere = await project();
    await saveSession(record(elsewhere, A, "a chat from another project"));
    await fs.mkdir(sessionDirectory(here), { recursive: true });
    await fs.copyFile(path.join(sessionDirectory(elsewhere), `${A}.json`), path.join(sessionDirectory(here), `${A}.json`));

    expect(await listSessions(here)).toEqual([]);
    expect(await loadSession(here, A)).toBeNull();

    // Even a stale index row naming it is not offered: ownership is checked against the snapshot.
    const staleIndex = { sessions: async () => [{ sessionId: A, title: "a chat from another project", createdAt: null, updatedAt: Date.now(), revision: 0, eventCount: 1, lastSequence: 1, hasSnapshot: true, hasJournal: false }] };
    const offered = await findRecentSession({
      stateHistory: staleIndex,
      listSessions: (limit) => listSessions(here, limit),
      owns: async (id) => (await loadSession(here, id)) !== null,
    });
    expect(offered).toBeUndefined();
  });
});
