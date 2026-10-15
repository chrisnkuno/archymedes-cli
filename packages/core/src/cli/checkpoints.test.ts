import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointStore, checkpointRef } from "./checkpoints";

// Real git against a real directory: the mechanism is git's plumbing, so a stand-in would test nothing.
let root: string;
let store: CheckpointStore;
const file = (name: string) => path.join(root, name);
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  store = new CheckpointStore(root, path.join(root, ".archymedes", "checkpoint-index"));
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe("CheckpointStore", () => {
  it("is available in a repository and not outside one", async () => {
    expect(await store.isAvailable()).toBe(true);
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-none-"));
    try {
      expect(await new CheckpointStore(bare, path.join(bare, "i")).isAvailable()).toBe(false);
      expect(await new CheckpointStore(bare, path.join(bare, "i")).capture("x", "t", 0)).toBeUndefined();
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it("captures on a brand-new project (the first turn is where undo matters)", async () => {
    await fs.writeFile(file("a.txt"), "one");
    const checkpoint = await store.capture("first", "turn-1", 2);
    expect(checkpoint).toMatchObject({ label: "first", turnId: "turn-1", messageCount: 2 });
    expect(checkpoint?.tree).toMatch(/^[0-9a-f]{40}/);
    expect(store.latest()).toBe(checkpoint);
  });

  it("restores edited, deleted and created files to the snapshot", async () => {
    await fs.writeFile(file("keep.txt"), "original");
    await fs.writeFile(file("gone.txt"), "will be deleted");
    const checkpoint = (await store.capture("before", "t", 0))!;
    await fs.writeFile(file("keep.txt"), "changed");
    await fs.rm(file("gone.txt"));
    await fs.writeFile(file("new.txt"), "created later");
    expect(await store.restore(checkpoint.tree)).toBe(true);
    expect(await fs.readFile(file("keep.txt"), "utf8")).toBe("original");
    expect(await fs.readFile(file("gone.txt"), "utf8")).toBe("will be deleted");
    await expect(fs.access(file("new.txt"))).rejects.toThrow();
  });

  it("never touches the user's own staging area", async () => {
    await fs.writeFile(file("staged.txt"), "staged");
    git("add", "staged.txt");
    await fs.writeFile(file("loose.txt"), "loose");
    await store.capture("c", "t", 0);
    expect(git("diff", "--cached", "--name-only").trim()).toBe("staged.txt");
  });

  it("keeps Archymedes's own state out of snapshots and out of a restore", async () => {
    await fs.mkdir(file(".archymedes"), { recursive: true });
    await fs.writeFile(file(".archymedes/session.jsonl"), "history");
    await fs.writeFile(file("code.txt"), "v1");
    const checkpoint = (await store.capture("c", "t", 0))!;
    await fs.writeFile(file("code.txt"), "v2");
    await store.restore(checkpoint.tree);
    expect(await fs.readFile(file(".archymedes/session.jsonl"), "utf8")).toBe("history");
  });

  it("shows what changed since the last checkpoint, new files included", async () => {
    expect(await store.diffPatch()).toBe("");
    await fs.writeFile(file("a.txt"), "line one\n");
    await store.capture("c", "t", 0);
    await fs.writeFile(file("a.txt"), "line one\nline two\n");
    await fs.writeFile(file("b.txt"), "brand new\n");
    const patch = await store.diffPatch();
    expect(patch).toContain("+line two");
    expect(patch).toContain("b.txt");
    expect(await store.diffStat()).toContain("2 files changed");
    expect(git("status", "--porcelain")).not.toContain("A "); // nothing was staged for the user
  });

  it("keeps every checkpoint's tree by a hidden ref, so git gc cannot take it", async () => {
    const kept = new CheckpointStore(root, path.join(root, ".archymedes", "kept-index"), undefined, () => "session-a");
    await fs.writeFile(file("a.txt"), "one");
    const first = (await kept.capture("first", "t1", 0))!;
    await fs.writeFile(file("a.txt"), "two");
    const second = (await kept.capture("second", "t2", 2))!;
    expect(git("rev-parse", checkpointRef("session-a", 0)).trim()).toBe(first.tree);
    expect(git("rev-parse", checkpointRef("session-a", 1)).trim()).toBe(second.tree);
    // Not a branch, not a tag: nothing a person sees or pushes.
    expect(git("branch", "--all")).toBe("");
    git("gc", "-q", "--prune=now");
    expect(git("cat-file", "-t", first.tree).trim()).toBe("tree");
  });

  it("takes over a stored session's checkpoints, leaving out trees git no longer has", async () => {
    await fs.writeFile(file("a.txt"), "one");
    const real = (await store.capture("real", "t1", 0))!;
    const resumed = new CheckpointStore(root, path.join(root, ".archymedes", "other-index"), undefined, () => "resumed");
    await resumed.load([real, { ...real, tree: "0".repeat(40), label: "pruned" }]);
    expect(resumed.list().map((checkpoint) => checkpoint.label)).toEqual(["real"]);
    expect(git("rev-parse", checkpointRef("resumed", 0)).trim()).toBe(real.tree);
    await fs.writeFile(file("a.txt"), "changed");
    expect(await resumed.restore(resumed.at(0)!.tree)).toBe(true);
    expect(await fs.readFile(file("a.txt"), "utf8")).toBe("one");
  });

  it("a capture during a load is not lost to it", async () => {
    await fs.writeFile(file("a.txt"), "one");
    const real = (await store.capture("stored", "t1", 0))!;
    const resumed = new CheckpointStore(root, path.join(root, ".archymedes", "other-index"), undefined, () => "r");
    const loading = resumed.load([real]);
    const captured = resumed.capture("new", "t2", 2);
    await Promise.all([loading, captured]);
    expect(resumed.list().map((checkpoint) => checkpoint.label)).toEqual(["stored", "new"]);
  });

  it("drops a checkpoint and every later one, refs included", async () => {
    const kept = new CheckpointStore(root, path.join(root, ".archymedes", "kept-index"), undefined, () => "s");
    for (const label of ["a", "b", "c"]) {
      await fs.writeFile(file("f.txt"), label);
      await kept.capture(label, label, 0);
    }
    await kept.dropFrom(1);
    expect(kept.list().map((checkpoint) => checkpoint.label)).toEqual(["a"]);
    expect(git("for-each-ref", "--format=%(refname)", "refs/archymedes").trim()).toBe(checkpointRef("s", 0));
  });

  it("shows one turn's own changes: to the next checkpoint, or to the workspace for the last", async () => {
    await fs.writeFile(file("a.txt"), "one\n");
    await store.capture("turn 1", "t1", 0);
    await fs.writeFile(file("a.txt"), "one\ntwo\n");
    await store.capture("turn 2", "t2", 2);
    await fs.writeFile(file("b.txt"), "three\n");
    const first = await store.turnPatch(0);
    expect(first).toContain("+two");
    expect(first).not.toContain("b.txt");
    const last = await store.turnPatch(1);
    expect(last).toContain("b.txt");
    expect(last).not.toContain("+two");
    expect(await store.turnPatch(5)).toBe("");
  });
});
