import { describe, expect, it } from "vitest";
import { COMMANDS } from "../catalog/commands";
import { CommandUsage, ESSENTIAL_COMMANDS, isEssential, renderHint, renderRecovery, renderSuggestions, suggestHints, suggestNext, type NavContext } from "./navigation";

const base: NavContext = {
  mode: "build", turns: 0, changedFiles: 0, openTodos: 0, runningJobs: 0, tabs: 1,
  sandbox: false, providerConfigured: true, hasSpend: false, recent: [],
};
const style = { width: 78, depth: "none" as const };

describe("suggestions", () => {
  it("says the one blocking thing and nothing else when nothing can work yet", () => {
    expect(suggestNext({ ...base, providerConfigured: false, changedFiles: 9, runningJobs: 3 }))
      .toEqual([{ command: "/settings", reason: "no model provider is configured yet" }]);
  });

  it("offers review after the agent has changed files, with the count as the reason", () => {
    const suggestions = suggestNext({ ...base, turns: 1, changedFiles: 3 });
    expect(suggestions[0]).toEqual({ command: "/diff", reason: "3 files changed and not looked at yet" });
    expect(suggestions.map((suggestion) => suggestion.command)).toContain("/undo");
  });

  it("counts in singular and plural rather than saying '1 files'", () => {
    expect(suggestNext({ ...base, turns: 1, changedFiles: 1 })[0].reason).toBe("1 file changed and not looked at yet");
    expect(suggestNext({ ...base, turns: 1, openTodos: 1 }).find((s) => s.command === "/todos")?.reason).toContain("1 item ");
  });

  it("stops offering what this session has already used", () => {
    const context = { ...base, turns: 1, changedFiles: 2 };
    expect(suggestNext(context).map((s) => s.command)).toContain("/diff");
    expect(suggestNext({ ...context, recent: ["/diff"] }).map((s) => s.command)).not.toContain("/diff");
  });

  it("moves a finished plan towards building it", () => {
    const suggestions = suggestNext({ ...base, mode: "plan", turns: 2 });
    expect(suggestions.map((s) => s.command)).toContain("/build");
  });

  it("points at the security work when a scan found something and the mode cannot fix it", () => {
    expect(suggestNext({ ...base, turns: 1, openFindings: 4 })[0])
      .toEqual({ command: "/defender", reason: "4 security findings to work through" });
    // Already in defender mode: the suggestion would be telling you to do what you are doing.
    expect(suggestNext({ ...base, mode: "defender", turns: 1, openFindings: 4 }).map((s) => s.command)).not.toContain("/defender");
  });

  it("never suggests more than it was asked for, and nothing at all when there is nothing to say", () => {
    expect(suggestNext({ ...base, turns: 1 }, 2).length).toBeLessThanOrEqual(2);
    expect(suggestNext({ ...base, turns: 1, recent: ["/detach"] }, 3)).toEqual([]);
  });
});

describe("rendering", () => {

  it("writes one line, or none at all when there is nothing worth saying", () => {
    const line = renderSuggestions({ ...base, turns: 1, changedFiles: 2 }, style, { limit: 1 });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("/diff");
    expect(renderSuggestions({ ...base, turns: 1, recent: ["/detach"] }, style, { limit: 1 })).toBe("");
  });
});

describe("session usage", () => {
  it("keeps most recent first, without repeats", () => {
    const log = new CommandUsage();
    log.record("/diff");
    log.record("/model claude-opus-5");
    log.record("/diff");
    expect(log.recent).toEqual(["/diff", "/model"]);
  });

  it("ignores anything that is not a command", () => {
    const log = new CommandUsage();
    log.record("fix the failing test");
    log.record("  ");
    expect(log.recent).toEqual([]);
  });

  it("remembers a bounded number of them", () => {
    const log = new CommandUsage(3);
    for (const command of ["/a", "/b", "/c", "/d"]) log.record(command);
    expect(log.recent).toEqual(["/d", "/c", "/b"]);
  });
});

describe("the suggestive prompt", () => {
  it("shows what to do next, and one thing worth knowing when there is room", () => {
    const block = renderSuggestions({ ...base, turns: 5, hasSpend: true }, style, { limit: 2, hints: true });
    const lines = block.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("drops the teaching line first when the session has real work to report", () => {
    // Two next steps fill the block; an ambient hint printed under them would be a third thing to
    // skip past, and the row people learn to skip is the row nothing can be taught in again.
    const busy = { ...base, turns: 5, changedFiles: 3, hasSpend: true };
    const block = renderSuggestions(busy, style, { limit: 2, hints: true });
    const lines = block.split("\n");
    expect(lines).toHaveLength(2);
    for (const hint of suggestHints(busy, 3)) expect(block).not.toContain(hint.reason);
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(renderSuggestions({ ...base, turns: 1, recent: ["/detach"] }, style, { limit: 2 })).toBe("");
  });

  it("teaches something in an empty result, and stops once it has been taken", () => {
    const quiet = { ...base, turns: 4 };
    const hint = renderHint(quiet, style);
    expect(hint).not.toBe("");
    const taken = suggestHints(quiet, 9).map((suggestion) => suggestion.command);
    expect(renderHint({ ...quiet, recent: taken }, style)).toBe("");
  });

  it("offers a way out of a failure, naming the failure", () => {
    const recovery = renderRecovery({ ...base, turns: 1, lastStatus: "failed", lastError: "401 invalid api key" }, style);
    expect(recovery).toContain("/settings");
    expect(recovery).toContain("key");
  });

  it("offers no way out when nothing failed", () => {
    expect(renderRecovery({ ...base, turns: 1, lastStatus: "completed" }, style)).toBe("");
  });
});

/**
 * The few commands a first session actually needs.
 *
 * Grouping answers "what is this for", which is the wrong question on day one: forty rows in six
 * honest categories still reads as forty rows. These tests pin the shorter answer — that a small
 * marked set exists, that it survives every filter and truncation between the catalog and the
 * screen, and that it stays small.
 */
describe("the commands worth learning first", () => {

  it("names commands that actually exist", () => {
    // A marked command that no longer exists is a star beside nothing, and the mark quietly stops
    // meaning anything the moment one entry is wrong.
    const known = new Set<string>(COMMANDS.map((command) => command.name));
    for (const name of ESSENTIAL_COMMANDS) expect(known.has(name), `${name} is not a command`).toBe(true);
  });

  it("stays short enough to be a shortlist", () => {
    // A list where the eighth item is "essential" is a list whose first item is not. Additions
    // should have to displace something rather than accumulate.
    // Eight since /history and /settings joined: the way back to an earlier chat and the way to
    // change how this looks are both questions a first session asks.
    expect(ESSENTIAL_COMMANDS.length).toBeLessThanOrEqual(8);
    expect(new Set(ESSENTIAL_COMMANDS).size).toBe(ESSENTIAL_COMMANDS.length);
  });

  it("covers the four questions a newcomer cannot answer any other way", () => {
    // Not a popularity ranking: each of these answers a question that will come up in a first
    // session and that nothing else in the interface answers.
    expect(isEssential("/help")).toBe(true);   // where is everything
    expect(isEssential("/diff")).toBe(true);   // what did it change
    expect(isEssential("/undo")).toBe(true);   // take that back
    expect(isEssential("/mode")).toBe(true);   // may it write to my files
    expect(isEssential("/tab")).toBe(false);   // real, useful, and not a day-one question
  });
});
