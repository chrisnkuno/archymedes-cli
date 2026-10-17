import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSession, saveSession, type SessionRecord } from "@archymedes/core/cli/session";
import { acquireSessionLease, sessionHolder } from "@archymedes/core/cli/session-lease";
import { engineFor, openSession, startingEngine, withOpenElsewhere, type SessionContext, type SessionEngine } from "./acp-session";
import { completed, FakeCodex, replyWith } from "./codex/fake-codex";
import { CodexSession } from "./codex/session";

/** A real Codex engine over a scripted app-server; the app-server itself is tested in codex/. */
function codexOver(fake: FakeCodex): SessionContext["codex"] {
  return async (ctx, record, mode, model) => {
    const session = new CodexSession({
      root: ctx.root, executable: "codex", environment: {}, mode, record, ...(model && model !== "default" ? { model } : {}),
      onEvent: ctx.onEvent, approve: ctx.approve, transport: fake.transport,
      git: async () => ({ exitCode: 128, stdout: "", stderr: "not a git repository" }),
      save: async () => undefined,
    });
    await session.open();
    return session;
  };
}

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
    expect(startingEngine({ provider: "claude", environment: {} }, openaiRecord)).toBe("claude");
    expect(startingEngine({ provider: "openai", environment: { ARCHYMEDES_PROVIDER: "claude" } }, claudeRecord)).not.toBe("claude");
    expect(startingEngine({ environment: {} }, claudeRecord)).toBe("claude");
    expect(startingEngine({ environment: { ARCHYMEDES_PROVIDER: "claude" } }, openaiRecord)).not.toBe("claude");
    expect(startingEngine({ environment: { ARCHYMEDES_PROVIDER: "Claude " } }, undefined)).toBe("claude");
    expect(startingEngine({ environment: { ARCHYMEDES_PROVIDER: "openai" } }, undefined)).not.toBe("claude");
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

  it("picks Codex when asked, when the session ran on it, or when it is the default", () => {
    expect(engineFor("codex")).toBe("codex");
    expect(startingEngine({ environment: {} }, { modelSelection: { provider: "codex", model: "default" } } as SessionRecord)).toBe("codex");
    expect(startingEngine({ environment: { ARCHYMEDES_PROVIDER: "codex" } }, undefined)).toBe("codex");
    expect(startingEngine({ provider: "openai", environment: { ARCHYMEDES_PROVIDER: "codex" } }, undefined)).toBe("archymedes");
  });

  it("keeps the conversation across Codex, Claude and back: each engine is told what it missed", async () => {
    const codex = new FakeCodex((prompt) => [...replyWith(`codex: ${prompt.split("\n").at(-1)}`), completed()]);
    const log: Array<{ record?: SessionRecord; mode: string; model?: string }> = [];
    const session = await openSession(context({ provider: "codex", codex: codexOver(codex), claude: fakeClaude(log) }));
    const id = session.id;
    await session.send("one");
    await session.setModel?.("claude", "opus");
    expect(log[0].record?.messages.map((message) => message.content)).toEqual(["one", "codex: one"]);
    await session.send("two");
    await session.setModel?.("codex", "gpt-6-luna");
    await session.send("three");
    expect(session.id).toBe(id);
    // Codex resumed its own thread and was told only the Claude turn it was not there for.
    expect(codex.requests.filter((request) => request.method === "thread/resume")).toHaveLength(1);
    expect(codex.prompts[1]).toContain("While you were away");
    expect(codex.prompts[1]).toContain("User: two");
    expect(codex.prompts[1]).toContain("Assistant: claude: two");
    expect(codex.prompts[1]).not.toContain("User: one");
    expect(codex.prompts[1].endsWith("\n\nthree")).toBe(true);
    expect(session.history?.().map((message) => message.content)).toEqual(["one", "codex: one", "two", "claude: two", "three", "codex: three"]);
    expect(session.info?.()).toMatchObject({ provider: "codex", model: "gpt-6-luna" });
    await session.dispose();
  });

  it("refuses Claude in a sandboxed session, which Claude Code cannot work in", async () => {
    const ctx = context({ provider: "claude", createWorkspace: async () => ({ error: "unused" }) });
    await expect(openSession(ctx)).rejects.toThrow("cannot work in a --sandbox workspace");
  });
});

describe("two terminals, one project", () => {
  const stored = (root: string, id: string, updatedAt: number): SessionRecord => ({
    schemaVersion: 2, revision: 0, id, createdAt: 1, updatedAt, root, title: `session ${id}`,
    messages: [{ role: "user", content: `hello from ${id}` }], approvals: { "v2:run_command:npm test": "allow" }, totalRwf: 0,
    modelSelection: { provider: "claude", model: "opus" }, claudeSession: `claude-${id}`,
  });

  it("never opens one session twice: the second gets a copy, with the conversation and none of the approvals", async () => {
    const log: Array<{ record?: SessionRecord; mode: string; model?: string }> = [];
    const ctx = context({ claude: fakeClaude(log) });
    await saveSession(stored(ctx.root, "s-one", 2));
    const first = await openSession(ctx, "s-one");
    expect(first.id).toBe("s-one");
    expect(first.info?.()).not.toHaveProperty("notice");

    const second = await openSession(ctx, "s-one");
    expect(second.id).not.toBe("s-one");
    expect(second.info?.()).toMatchObject({ notice: expect.stringContaining("open in another terminal") });
    expect(second.info?.()).not.toHaveProperty("notice"); // said once
    expect(log[1].record).toMatchObject({ id: second.id, approvals: {}, messages: [{ role: "user", content: "hello from s-one" }] });
    expect(log[1].record?.claudeSession).toBeUndefined(); // nor one Claude conversation between them
    // The original is untouched, approvals and all.
    expect((await loadSession(ctx.root, "s-one"))?.approvals).toEqual({ "v2:run_command:npm test": "allow" });

    // Closed, it is free again, and resumed as itself.
    await first.dispose();
    expect(await sessionHolder(ctx.root, "s-one")).toBeNull();
    const third = await openSession(ctx, "s-one");
    expect(third.id).toBe("s-one");
    await Promise.all([second.dispose(), third.dispose()]);
    expect(await sessionHolder(ctx.root, second.id)).toBeNull();
  });

  it("resumes the newest session nobody has open as latest, and copies the newest when every one is", async () => {
    const log: Array<{ record?: SessionRecord; mode: string; model?: string }> = [];
    const ctx = context({ claude: fakeClaude(log) });
    await saveSession(stored(ctx.root, "s-old", 1));
    await saveSession(stored(ctx.root, "s-new", 2));
    // The order sessions are listed in is their saved time, which saving just set: make s-new newer.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await loadSession(ctx.root, "s-new");
    await saveSession(newer!);
    const elsewhere = await acquireSessionLease(ctx.root, "s-new", { pid: process.ppid, heartbeatMs: 0 });
    const latest = await openSession(ctx, "latest");
    expect(latest.id).toBe("s-old");
    expect(latest.info?.()).not.toHaveProperty("notice");
    const listed = await withOpenElsewhere(ctx.root, [{ id: "s-new" }, { id: "s-old" }, { id: "s-none" }]);
    // Held by another process is "elsewhere"; held by this one (the session open here) is not.
    expect(listed).toEqual([{ id: "s-new", openElsewhere: true }, { id: "s-old" }, { id: "s-none" }]);

    const copy = await openSession(ctx, "latest");
    expect(copy.id).not.toMatch(/^s-/);
    expect(log.at(-1)?.record?.messages).toEqual([{ role: "user", content: "hello from s-new" }]);
    await Promise.all([latest.dispose(), copy.dispose(), "lease" in elsewhere ? elsewhere.lease.release() : undefined]);
  });

  it("takes a lease for a new session too, so a later --resume latest elsewhere does not land in it", async () => {
    const log: Array<{ record?: SessionRecord; mode: string; model?: string }> = [];
    const ctx = context({ claude: fakeClaude(log) });
    ctx.environment.ARCHYMEDES_PROVIDER = "claude";
    const session = await openSession(ctx);
    expect(await sessionHolder(ctx.root, session.id)).toMatchObject({ pid: process.pid });
    await session.dispose();
    expect(await sessionHolder(ctx.root, session.id)).toBeNull();
  });

  it("lets go of the lease when the engine cannot start", async () => {
    const ctx = context({ claude: fakeClaude([], { fail: "Claude Code is not signed in" }) });
    await saveSession(stored(ctx.root, "s-fail", 2));
    await expect(openSession(ctx, "s-fail")).rejects.toThrow("not signed in");
    expect(await sessionHolder(ctx.root, "s-fail")).toBeNull();
  });
});
