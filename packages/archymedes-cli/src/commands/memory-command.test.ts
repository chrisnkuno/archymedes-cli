import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNICODE_GLYPHS } from "../text/glyphs";
import type { MemoryEntry } from "./memory";
import { runMemoryCommand, type MemoryCommandContext } from "./memory-command";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "archymedes-memory-cmd-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function context(confirm = true) {
  const written: string[] = [];
  const state: { memories: MemoryEntry[] } = { memories: [] };
  const same = (text: string) => text;
  const ctx = (): MemoryCommandContext => ({
    root,
    environment: { ARCHYMEDES_CONFIG_DIR: path.join(root, "config") },
    memories: state.memories,
    setMemories: (entries) => { state.memories = entries; },
    confirm: async () => confirm,
    write: (text) => written.push(text),
    paint: { dim: same, yellow: same, green: same },
    style: { width: 80, depth: "none" },
    glyphs: UNICODE_GLYPHS,
  });
  return { ctx, written, state };
}

describe("/memory", () => {
  it("adds, dedupes, recalls and forgets a project fact, reloading after each change", async () => {
    const { ctx, written, state } = context();
    await runMemoryCommand({ kind: "add", scope: "project", text: "tests run with bun", memoryKind: "fact", pinned: false }, ctx());
    expect(state.memories.map((entry) => entry.text)).toEqual(["tests run with bun"]);
    await runMemoryCommand({ kind: "add", scope: "project", text: "tests run with bun", memoryKind: "fact", pinned: false }, ctx());
    expect(written.at(-1)).toContain("already remembered");
    await runMemoryCommand({ kind: "recall", query: "bun" }, ctx());
    expect(written.at(-1)).toContain("chars recalled");
    await runMemoryCommand({ kind: "forget", scope: "project", index: 1 }, ctx());
    expect(written.at(-1)).toContain("forgot: tests run with bun");
    expect(state.memories).toEqual([]);
  });

  it("keeps memories when clearing is not confirmed", async () => {
    const { ctx, written, state } = context(false);
    await runMemoryCommand({ kind: "add", scope: "project", text: "keep me", memoryKind: "fact", pinned: false }, ctx());
    await runMemoryCommand({ kind: "clear", scope: "project" }, ctx());
    expect(written.at(-1)).toContain("kept");
    expect(state.memories).toHaveLength(1);
  });
});
