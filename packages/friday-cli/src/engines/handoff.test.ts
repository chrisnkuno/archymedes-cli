import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@archymedes/core/cli/session";
import { handoffPreface, markSeen, prefaceFrom } from "./handoff";

const record = (messages: SessionRecord["messages"], engineSeen?: Record<string, number>): SessionRecord => ({
  schemaVersion: 2, revision: 0, id: "s", createdAt: 0, updatedAt: 0, root: "/p", title: "t", messages, approvals: {}, totalRwf: 0, ...(engineSeen ? { engineSeen } : {}),
});

describe("context across engines", () => {
  const talk: SessionRecord["messages"] = [
    { role: "user", content: "one" }, { role: "assistant", content: "first answer" },
    { role: "user", content: "two" }, { role: "assistant", content: "second answer" },
  ];

  it("tells an engine that never saw the session the whole conversation, and one that did only what it missed", () => {
    expect(handoffPreface(record(talk), "codex", false)).toBe(prefaceFrom(talk));
    const back = handoffPreface(record(talk, { codex: 2 }), "codex", true);
    expect(back).toContain("While you were away");
    expect(back).toContain("User: two");
    expect(back).not.toContain("User: one");
  });

  it("says nothing to an engine that has seen everything, or to one from before seen-marks existed", () => {
    expect(handoffPreface(record(talk, { claude: 4 }), "claude", true)).toBe("");
    expect(handoffPreface(record(talk), "claude", true)).toBe(""); // its own conversation is assumed whole
    expect(handoffPreface(record(talk, { claude: 99 }), "claude", true)).toBe(""); // a rewound transcript
  });

  it("marks what an engine has seen, without forgetting the others", () => {
    const value = record(talk, { claude: 2 });
    markSeen(value, "codex");
    expect(value.engineSeen).toEqual({ claude: 2, codex: 4 });
  });
});
