import { describe, expect, it } from "vitest";
import {
  annotateLines,
  composeExplainPanel,
  cycleExplainTab,
  initialExplainPanelState,
  structuralFacts,
  toggleExplainPanel,
  withAiExplanation,
} from "./explain-view";

describe("structuralFacts", () => {
  it("finds imports, exports, classes and functions in a typescript file", () => {
    const facts = structuralFacts(
      [
        "import { readFile } from \"node:fs\";",
        "export function run() {}",
        "export class Runner {}",
        "function helper() {}",
      ].join("\n"),
      "src/thing.ts",
    );
    expect(facts.imports).toHaveLength(1);
    expect(facts.exports.map((entry) => entry.text)).toEqual(["run", "Runner"]);
    expect(facts.classes.map((entry) => entry.text)).toEqual(["Runner"]);
    expect(facts.functions.map((entry) => entry.text)).toEqual(["run", "helper"]);
  });

  it("finds python imports and defs", () => {
    const facts = structuralFacts("import os\n\ndef run():\n    pass\n", "thing.py");
    expect(facts.imports).toHaveLength(1);
    expect(facts.functions.map((entry) => entry.text)).toEqual(["run"]);
  });

  it("returns empty facts for a language it has no rules for", () => {
    const facts = structuralFacts("SELECT * FROM users;", "query.sql");
    expect(facts.imports).toHaveLength(0);
    expect(facts.functions).toHaveLength(0);
  });
});

describe("annotateLines", () => {
  it("flags unfinished work", () => {
    const notes = annotateLines("const x = 1;\n// TODO: fix this\n");
    expect(notes.some((note) => note.line === 2 && note.severity === "warn")).toBe(true);
  });

  it("flags long lines", () => {
    const notes = annotateLines(`const x = "${"a".repeat(130)}";`);
    expect(notes.some((note) => note.note.includes("long line"))).toBe(true);
  });

  it("flags unexplained numeric literals but not commented-out numbers", () => {
    const notes = annotateLines("setTimeout(fn, 4200);\n// 4200 is fine here\n");
    expect(notes.filter((note) => note.note.includes("numeric"))).toHaveLength(1);
  });

  it("finds nothing in clean short code", () => {
    expect(annotateLines("const x = 1;\nconst y = 2;\n")).toEqual([]);
  });
});

describe("explain panel state", () => {
  it("starts closed on the facts tab", () => {
    const state = initialExplainPanelState();
    expect(state.open).toBe(false);
    expect(state.tab).toBe("facts");
    expect(state.ai.status).toBe("idle");
  });

  it("toggles open and closed", () => {
    const state = initialExplainPanelState();
    expect(toggleExplainPanel(state).open).toBe(true);
    expect(toggleExplainPanel(toggleExplainPanel(state)).open).toBe(false);
  });

  it("cycles tabs forward and wraps", () => {
    let state = initialExplainPanelState();
    state = cycleExplainTab(state, 1);
    expect(state.tab).toBe("notes");
    state = cycleExplainTab(state, 1);
    expect(state.tab).toBe("diff");
    state = cycleExplainTab(state, 1);
    expect(state.tab).toBe("ai");
    state = cycleExplainTab(state, 1);
    expect(state.tab).toBe("facts");
  });

  it("cycles backward too", () => {
    const state = cycleExplainTab(initialExplainPanelState(), -1);
    expect(state.tab).toBe("ai");
  });

  it("carries an AI explanation once it resolves", () => {
    const state = withAiExplanation(initialExplainPanelState(), { status: "ready", text: "it does a thing" });
    expect(state.ai).toEqual({ status: "ready", text: "it does a thing" });
  });
});

describe("composeExplainPanel", () => {
  const base = { path: "thing.ts", before: "", after: "export function run() {}\n" };

  it("renders the facts tab with the tab strip on top", () => {
    const rows = composeExplainPanel({ ...base, panel: initialExplainPanelState() }, 40, 10);
    expect(rows[0].text).toContain("[Structure]");
    expect(rows.some((row) => row.text.includes("run"))).toBe(true);
  });

  it("renders the notes tab", () => {
    const panel = { open: true, tab: "notes" as const, ai: { status: "idle" as const } };
    const rows = composeExplainPanel({ ...base, panel }, 40, 10);
    expect(rows[0].text).toContain("[Notes]");
  });

  it("renders the diff tab against the original content", () => {
    const panel = { open: true, tab: "diff" as const, ai: { status: "idle" as const } };
    const rows = composeExplainPanel({ path: "thing.ts", before: "old\n", after: "new\n", panel }, 40, 10);
    expect(rows.some((row) => row.text.startsWith("+ new"))).toBe(true);
    expect(rows.some((row) => row.text.startsWith("- old"))).toBe(true);
  });

  it("renders the ai tab's idle prompt", () => {
    const panel = { open: true, tab: "ai" as const, ai: { status: "idle" as const } };
    const rows = composeExplainPanel({ ...base, panel }, 40, 10);
    expect(rows.some((row) => row.text.includes("Press ? "))).toBe(true);
  });

  it("pads short content to the requested height", () => {
    const rows = composeExplainPanel({ ...base, panel: initialExplainPanelState() }, 40, 20);
    expect(rows).toHaveLength(20);
  });
});
