import { describe, expect, it } from "vitest";
import { RECENT_SESSION_MS, findRecentSession, resumeOfferLine, resumePreference } from "./resume-offer";

const now = Date.UTC(2026, 9, 8);
const none = { sessions: async () => null };

describe("offering to continue the last chat", () => {
  it("asks by default, and honours always and never", () => {
    expect(resumePreference({})).toBe("ask");
    expect(resumePreference({ ARCHYMEDES_RESUME: "Always" })).toBe("always");
    expect(resumePreference({ ARCHYMEDES_RESUME: "never" })).toBe("never");
    expect(resumePreference({ ARCHYMEDES_RESUME: "sometimes" })).toBe("ask");
  });

  it("finds the newest chat when it is recent, and nothing when it is old", async () => {
    const recent = await findRecentSession({ stateHistory: none, listSessions: async () => [{ id: "a", title: "fix the parser", updatedAt: now - 3600_000 }], now });
    expect(recent).toEqual({ id: "a", title: "fix the parser", updatedAt: now - 3600_000 });
    const old = await findRecentSession({ stateHistory: none, listSessions: async () => [{ id: "a", title: "x", updatedAt: now - RECENT_SESSION_MS - 1 }], now });
    expect(old).toBeUndefined();
    expect(await findRecentSession({ stateHistory: none, listSessions: async () => [], now })).toBeUndefined();
  });

  it("prefers the native index, and treats a failure as no offer rather than an error", async () => {
    const indexed = { sessions: async () => [{ sessionId: "b", title: "indexed", createdAt: null, updatedAt: now, revision: 1, eventCount: 2, lastSequence: 2, hasSnapshot: true, hasJournal: false }] };
    expect((await findRecentSession({ stateHistory: indexed, listSessions: async () => [], now }))?.id).toBe("b");
    const broken = { sessions: async () => { throw new Error("locked"); } };
    expect(await findRecentSession({ stateHistory: broken, listSessions: async () => [], now })).toBeUndefined();
  });

  it("names the chat and the two answers in one line", () => {
    const line = resumeOfferLine({ id: "a", title: "fix the parser", updatedAt: now }, { middot: "·" }, () => "2h ago");
    expect(line).toBe('Continue your last chat "fix the parser" (2h ago)? Enter = yes · type to start fresh');
  });
});
