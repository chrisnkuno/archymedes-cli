import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointStore } from "./checkpoints";

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
});
