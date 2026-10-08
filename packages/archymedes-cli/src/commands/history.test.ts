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

  it("deletes from the picker when deleting is wired, and says so in its legend", async () => {
    const removed: string[] = [];
    let legend: string | undefined;
    const picker = context({
      remove: async (id) => { removed.push(id); return { deleted: true }; },
      removeAll: async () => ({ deleted: 0 }),
      choose: async (items, extras) => {
        legend = extras?.legend;
        await extras?.onDelete?.(items.find((item) => item.label === "add a health check")!);
        return undefined;
      },
    });
    await runHistoryCommand({ kind: "browse" }, picker.ctx);
    expect(removed).toEqual([B]);
    expect(legend).toContain("Del delete");
    expect(legend).toContain("Esc back");
  });

  it("deletes by id, and deletes all only after a yes", async () => {
    const one = context({ remove: async () => ({ deleted: true }), removeAll: async () => ({ deleted: 0 }) });
    await runHistoryCommand({ kind: "delete", id: B }, one.ctx);
    expect(one.written.join("")).toContain(`deleted ${B}`);

    const refused = context({ remove: async () => ({ deleted: false, reason: "That is the chat you are in" }), removeAll: async () => ({ deleted: 0 }) });
    await runHistoryCommand({ kind: "delete", id: A }, refused.ctx);
    expect(refused.written.join("")).toContain("chat you are in");

    let wiped = 0;
    const declined = context({ remove: async () => ({ deleted: true }), removeAll: async () => { wiped += 1; return { deleted: 1 }; }, confirm: async () => false });
    await runHistoryCommand({ kind: "delete", all: true }, declined.ctx);
    expect(wiped).toBe(0);
    expect(declined.written.join("")).toContain("nothing deleted");

    const accepted = context({ remove: async () => ({ deleted: true }), removeAll: async () => { wiped += 1; return { deleted: 1 }; }, confirm: async (question) => question.includes("1 other chat") });
    await runHistoryCommand({ kind: "delete", all: true }, accepted.ctx);
    expect(wiped).toBe(1);
    expect(accepted.written.join("")).toContain("deleted 1 chat");

    const unconfirmable = context({ remove: async () => ({ deleted: true }), removeAll: async () => { wiped += 1; return { deleted: 1 }; } });
    await runHistoryCommand({ kind: "delete", all: true }, unconfirmable.ctx);
    expect(wiped).toBe(1);
  });

  it("opens the picker on a bare /history, and prints the list where nobody can pick", async () => {
    const picking = context({ choose: async (items) => items.find((item) => item.label === "fix the parser")?.value });
    await runHistoryCommand({ kind: "browse" }, picking.ctx);
    expect(picking.resumed).toEqual([A]);
    const piped = context();
    await runHistoryCommand({ kind: "browse" }, piped.ctx);
    expect(piped.resumed).toEqual([]);
    expect(piped.written.join("")).toContain("fix the parser");
  });
});
