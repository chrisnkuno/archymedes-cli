import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveSession, type SessionRecord } from "@archymedes/core/cli/session";
import { openSession, startsOnClaude, type SessionContext, type SessionEngine } from "./acp-session";

/** A Claude engine that records what it was given; the real one is tested in claude/session.test.ts. */
function fakeClaude(log: Array<{ record?: SessionRecord; mode: string; model?: string }>, options: { fail?: string } = {}): SessionContext["claude"] {
  return async (_context, record, mode, model) => {
    if (options.fail) throw new Error(options.fail);
    log.push({ record, mode, model });
    let current = structuredClone(record ?? { schemaVersion: 2, revision: 0, id: "claude-new", createdAt: 1, updatedAt: 1, root: "/", title: "t", messages: [], approvals: {}, totalRwf: 0 } as SessionRecord);
    let disposed = false;
    const engine: SessionEngine & { disposed: () => boolean } = {
      kind: "claude",
      get id() { return current.id; },
      send: async (prompt) => {
        current = { ...current, messages: [...current.messages, { role: "user", content: prompt }, { role: "assistant", content: `claude: ${prompt}` }] };
        return { status: "completed", summary: "ok" };
      },
      cancel: () => undefined,
      setMode: async () => undefined,
      setModel: async (_provider, next) => { current = { ...current, modelSelection: { provider: "claude", model: next ?? "default" } }; },
      dispose: async () => { disposed = true; },
      history: () => current.messages,
      snapshot: () => ({ ...structuredClone(current), modelSelection: { provider: "claude", model: model ?? "default" } }),
      info: () => ({ sessionId: current.id, provider: "claude", model: model ?? "default" }),
      disposed: () => disposed,
    };
    return engine;
  };
}

function context(overrides: Partial<SessionContext> = {}): SessionContext {
  const root = mkdtempSync(path.join(os.tmpdir(), "archymedes-session-"));
  return {
    root, mode: "build",
    environment: { OPENAI_API_KEY: "sk-test", ARCHYMEDES_CONFIG_DIR: path.join(root, ".config"), ARCHYMEDES_JEV: "off", ARCHYMEDES_EDIT_DIAGNOSTICS: "off" },
    onEvent: () => undefined, approve: async () => "deny",
    ...overrides,
  };
}

describe("which engine a session starts on", () => {
  it("is Claude when asked for, when the stored session ran on it, or when it is the default for new ones", () => {
    const claudeRecord = { modelSelection: { provider: "claude", model: "opus" } } as SessionRecord;
    const openaiRecord = { modelSelection: { provider: "openai", model: "gpt" } } as SessionRecord;
    expect(startsOnClaude({ provider: "claude", environment: {} }, openaiRecord)).toBe(true);
    expect(startsOnClaude({ provider: "openai", environment: { ARCHYMEDES_PROVIDER: "claude" } }, claudeRecord)).toBe(false);
    expect(startsOnClaude({ environment: {} }, claudeRecord)).toBe(true);
    expect(startsOnClaude({ environment: { ARCHYMEDES_PROVIDER: "claude" } }, openaiRecord)).toBe(false);
    expect(startsOnClaude({ environment: { ARCHYMEDES_PROVIDER: "Claude " } }, undefined)).toBe(true);
    expect(startsOnClaude({ environment: { ARCHYMEDES_PROVIDER: "openai" } }, undefined)).toBe(false);
  });
});

describe("one session, either engine", () => {
  it("opens on Claude when it is the default, with the remembered model", async () => {
    const log: Array<{ record?: SessionRecord; mode: string; model?: string }> = [];
    const ctx = context({ claude: fakeClaude(log) });
    ctx.environment.ARCHYMEDES_PROVIDER = "claude";
    ctx.environment.CLAUDE_MODEL = "sonnet";
    const session = await openSession(ctx);
    expect(log).toEqual([{ record: undefined, mode: "build", model: "sonnet" }]);
    expect(session.info?.()).toMatchObject({ provider: "claude", model: "sonnet" });
  });

  it("moves to Claude and back keeping its id, and each engine is given the other's transcript", async () => {
    const log: Array<{ record?: SessionRecord; mode: string; model?: string }> = [];
    const session = await openSession(context({ claude: fakeClaude(log), mode: "plan" }));
    const id = session.id;
    expect(session.info?.()).toMatchObject({ provider: "openai" });

    await session.setModel?.("claude", "opus");
    expect(log[0]).toMatchObject({ mode: "plan", model: "opus", record: { id } });
    expect(session.id).toBe(id);
    expect(session.info?.()).toMatchObject({ provider: "claude", model: "opus" });

    await session.send("hello");
    await session.setModel?.("claude", "haiku"); // within Claude: no new engine
    expect(log).toHaveLength(1);

    await session.setModel?.("openai", "gpt-5.6-terra");
    expect(session.id).toBe(id);
    expect(session.info?.()).toMatchObject({ provider: "openai", model: "gpt-5.6-terra", mode: "plan" });
    expect(session.history?.().map((message) => message.content)).toEqual(["hello", "claude: hello"]);
    await session.dispose();
  });

  it("stays as it was when the switch cannot happen", async () => {
    const session = await openSession(context({ claude: fakeClaude([], { fail: "Claude is not ready: it needs signing in" }) }));
    await expect(session.setModel?.("claude")).rejects.toThrow("signing in");
    expect(session.info?.()).toMatchObject({ provider: "openai" });
    await expect(session.setModel?.("groq")).rejects.toThrow(/GROQ_API_KEY/);
    expect(session.info?.()).toMatchObject({ provider: "openai" });
    await session.dispose();
  });

  it("resumes a stored Claude session on Claude, given its record", async () => {
    const log: Array<{ record?: SessionRecord; mode: string; model?: string }> = [];
    const ctx = context({ claude: fakeClaude(log) });
    const record: SessionRecord = { schemaVersion: 2, revision: 0, id: "20261015T120000Z-claude", createdAt: 1, updatedAt: 2, root: ctx.root, title: "Earlier", messages: [{ role: "user", content: "hi" }], approvals: {}, totalRwf: 0, mode: "auto", modelSelection: { provider: "claude", model: "opus" }, claudeSession: "c-1" };
    await saveSession(record);
    const session = await openSession(ctx, "latest");
    expect(log[0]).toMatchObject({ mode: "auto", record: { id: "20261015T120000Z-claude", claudeSession: "c-1" } });
    expect(session.history?.()).toEqual([{ role: "user", content: "hi" }]);
  });

  it("refuses Claude in a sandboxed session, which Claude Code cannot work in", async () => {
    const ctx = context({ provider: "claude", createWorkspace: async () => ({ error: "unused" }) });
    await expect(openSession(ctx)).rejects.toThrow("cannot work in a --sandbox workspace");
  });
});
