import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointStore, checkpointRef } from "./checkpoints";
import { loadSession, newSessionId, saveSession, type SessionRecord } from "./session";
import { forkSession, forkTitle } from "./session-fork";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fork-"));
  git("init", "-q");
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe("forking a session", () => {
  it("copies the conversation and checkpoints into a new id, with refs of its own, leaving the original as it was", async () => {
    const id = newSessionId();
    const store = new CheckpointStore(root, path.join(root, ".archymedes", "index"), undefined, () => id);
    await fs.writeFile(path.join(root, "a.txt"), "one");
    const checkpoint = (await store.capture("first", "t1", 1))!;
    const original: SessionRecord = {
      schemaVersion: 2, revision: 0, id, createdAt: 1, updatedAt: 1, root, title: "fix the parser",
      messages: [{ role: "user", content: "fix the parser" }, { role: "assistant", content: "Fixed." }],
      approvals: {}, totalRwf: 0, checkpoints: [checkpoint], claudeSession: "claude-123",
    };
    await saveSession(original);
    const before = await loadSession(root, id);

    const fork = await forkSession(before!);
    expect(fork.id).not.toBe(id);
    expect(fork.title).toBe("fix the parser (fork)");
    expect(fork.claudeSession).toBeUndefined();
    const stored = await loadSession(root, fork.id);
    expect(stored?.messages).toEqual(original.messages);
    expect(stored?.checkpoints?.map((item) => item.tree)).toEqual([checkpoint.tree]);
    expect(git("rev-parse", checkpointRef(fork.id, 0)).trim()).toBe(checkpoint.tree);
    expect(git("rev-parse", checkpointRef(id, 0)).trim()).toBe(checkpoint.tree);
    expect(await loadSession(root, id)).toEqual(before);
  });

  it("shares no engine conversation with the original, and leaves approvals behind when asked to", async () => {
    const original: SessionRecord = {
      schemaVersion: 2, revision: 0, id: newSessionId(), createdAt: 1, updatedAt: 1, root, title: "t",
      messages: [{ role: "user", content: "hi" }], approvals: { "v2:run_command:npm test": "allow" }, totalRwf: 0,
      claudeSession: "claude-1", codexThread: "thread-1",
    };
    await saveSession(original);
    const kept = await forkSession((await loadSession(root, original.id))!);
    expect(kept.codexThread).toBeUndefined();
    expect(kept.claudeSession).toBeUndefined();
    expect(kept.approvals).toEqual(original.approvals);
    const fresh = await forkSession((await loadSession(root, original.id))!, undefined, { freshApprovals: true });
    expect((await loadSession(root, fresh.id))?.approvals).toEqual({});
    expect((await loadSession(root, original.id))?.approvals).toEqual(original.approvals);
  });

  it("does not pile up suffixes on a fork of a fork", () => {
    expect(forkTitle("a (fork)")).toBe("a (fork)");
  });
});
