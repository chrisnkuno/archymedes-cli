import type { SessionRecord } from "@archymedes/core/cli/session";
import { describe, expect, it } from "vitest";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { runHistoryCommand, type HistoryContext } from "./history";

const record = (id: string, title: string): SessionRecord => ({
  schemaVersion: 2, revision: 1, id, createdAt: 1_000, updatedAt: 2_000, root: "/repo", title, approvals: {}, totalRwf: 0,
  messages: [{ role: "user", content: title }, { role: "assistant", content: `done: ${title}` }],
} as SessionRecord);

const A = "20260808T001720Z-aaaaaa";
const B = "20260809T001720Z-bbbbbb";

function context(overrides: Partial<HistoryContext> = {}) {
  const written: string[] = [];
  const resumed: string[] = [];
  const records = new Map([[A, record(A, "fix the parser")], [B, record(B, "add a health check")]]);
  const same = (text: string) => text;
  const ctx: HistoryContext = {
    stateHistory: { sessions: async () => null, search: async () => null, refresh: async () => undefined, status: async () => ({ mode: "fallback", reason: "not installed" }) } as unknown as HistoryContext["stateHistory"],
    listSessions: async () => [{ id: B }, { id: A }],
    loadSession: async (id) => records.get(id),
    currentSessionId: A,
    resume: async (value) => { resumed.push(value.id); },
    write: (text) => written.push(text),
    paint: { dim: same, yellow: same, green: same },
    style: { width: 80, depth: "none" },
    glyphs: UNICODE_GLYPHS,
    ...overrides,
  };
  return { ctx, written, resumed };
}

describe("/history", () => {
  it("lists and searches the session files when the native index is unavailable", async () => {
    const list = context();
    await runHistoryCommand({ kind: "list" }, list.ctx);
    expect(list.written.join("")).toContain("add a health check");
    const search = context();
    await runHistoryCommand({ kind: "search", query: "parser" }, search.ctx);
    expect(search.written.join("")).toContain('"parser" · 1 match');
  });

  it("reports the fallback engine and explains an unknown session", async () => {
    const status = context();
    await runHistoryCommand({ kind: "status" }, status.ctx);
    expect(status.written.join("")).toContain("portable JSON history is active");
    const missing = context();
    await runHistoryCommand({ kind: "show", id: "nope" }, missing.ctx);
    expect(missing.written.join("")).toContain("No session nope.");
  });

  it("resumes the latest, a chosen one, or nothing when the picker is dismissed", async () => {
    const latest = context();
    await runHistoryCommand({ kind: "resume", id: "latest" }, latest.ctx);
    expect(latest.resumed).toEqual([B]);
    expect(latest.written.at(-1)).toContain(`resumed ${B}`);
    const picked = context({ choose: async (items) => items.find((item) => item.label === "fix the parser")?.value });
    await runHistoryCommand({ kind: "resume" }, picked.ctx);
    expect(picked.resumed).toEqual([A]);
    const dismissed = context({ choose: async () => undefined });
    await runHistoryCommand({ kind: "resume" }, dismissed.ctx);
    expect(dismissed.resumed).toEqual([]);
    expect(dismissed.written.at(-1)).toContain("no session chosen");
  });
});
