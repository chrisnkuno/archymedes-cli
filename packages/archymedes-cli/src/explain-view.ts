import { diffLines, languageOf, type DiffLine } from "./code-view";

/**
 * The explainable view: a side panel next to the editor that answers "what is this code, and why
 * does it look the way it does" without leaving the file.
 *
 * Same split as `editor.ts` and `file-browser.ts`: everything here is a pure function over a small
 * state value, so the four tabs (structure, notes, diff, AI) are each testable as strings in and
 * strings out, and the screen only has to turn rows into widgets and run the one effect a pure
 * module cannot — asking a model for an explanation.
 *
 * The three static tabs are deliberately cheap and approximate, in the same spirit as
 * `highlightCode`'s four-category lexer: a regex pass over the text, not a parser for any one
 * language, because covering every grammar exactly is a maintenance surface this view does not need
 * to carry to be useful. The fourth tab, AI, is the one place real understanding is worth paying a
 * request for — the static tabs exist so most questions never need one.
 */

export type StructuralFact = { line: number; text: string };

export type StructuralFacts = {
  imports: StructuralFact[];
  exports: StructuralFact[];
  functions: StructuralFact[];
  classes: StructuralFact[];
};

const PATTERNS: Record<string, Partial<Record<keyof StructuralFacts, RegExp>>> = {
  typescript: {
    imports: /^\s*import\b.*from\s+["'](.+)["']/,
    exports: /^\s*export\s+(?:default\s+)?(?:const|function|class|interface|type|enum)\s+([\w$]+)/,
    functions: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/,
    classes: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/,
  },
  javascript: {},
  jsx: {},
  tsx: {},
  python: {
    imports: /^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import\b)/,
    functions: /^\s*(?:async\s+)?def\s+([\w]+)/,
    classes: /^\s*class\s+([\w]+)/,
  },
  go: {
    imports: /^\s*import\s+["'](.+)["']/,
    functions: /^\s*func\s+(?:\([^)]*\)\s*)?([\w]+)/,
  },
  rust: {
    imports: /^\s*use\s+([\w:]+)/,
    functions: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([\w]+)/,
    classes: /^\s*(?:pub\s+)?struct\s+([\w]+)/,
  },
  ruby: {
    imports: /^\s*require\s+["'](.+)["']/,
    functions: /^\s*def\s+([\w?!]+)/,
    classes: /^\s*class\s+([\w:]+)/,
  },
};
PATTERNS.javascript = PATTERNS.typescript;
PATTERNS.jsx = PATTERNS.typescript;
PATTERNS.tsx = PATTERNS.typescript;

/**
 * The shape of a file, read off it in one pass: what it pulls in, what it hands out, and where its
 * functions and classes start.
 *
 * This is the answer to "what is this file, roughly" before reading a line of its body — the same
 * job a table of contents does for a document.
 */
export function structuralFacts(content: string, path: string): StructuralFacts {
  const language = languageOf(path);
  const rules = PATTERNS[language] ?? {};
  const facts: StructuralFacts = { imports: [], exports: [], functions: [], classes: [] };
  const lines = content.split("\n");
  lines.forEach((raw, index) => {
    for (const key of Object.keys(rules) as (keyof StructuralFacts)[]) {
      const pattern = rules[key];
      if (!pattern) continue;
      const match = pattern.exec(raw);
      if (!match) continue;
      const name = match.slice(1).find((group) => group !== undefined);
      facts[key].push({ line: index + 1, text: name ?? raw.trim() });
    }
  });
  return facts;
}

export type Annotation = { line: number; note: string; severity: "info" | "warn" };

const MAX_LINE_LENGTH = 120;
const MAGIC_NUMBER = /(?<![\w.])(?!0\b|1\b)\d{2,}(?![\w.])/;

/**
 * Per-line margin notes about the things a reader would otherwise have to notice for themselves:
 * unfinished work, a line too long to take in at a glance, a number with no name explaining it.
 *
 * Heuristic and intentionally noisy-averse — each rule fires on one line at a time and says exactly
 * what it saw, so a false positive costs one ignorable note rather than eroding trust in the tab.
 */
export function annotateLines(content: string): Annotation[] {
  const lines = content.split("\n");
  const notes: Annotation[] = [];
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(raw)) {
      notes.push({ line, note: "unfinished work flagged here", severity: "warn" });
    }
    if (raw.length > MAX_LINE_LENGTH) {
      notes.push({ line, note: `long line (${raw.length} chars)`, severity: "info" });
    }
    if (MAGIC_NUMBER.test(raw) && !/^\s*(?:\/\/|#|\*)/.test(raw)) {
      notes.push({ line, note: "unexplained numeric literal", severity: "info" });
    }
  });
  return notes;
}

export type ExplainTab = "facts" | "notes" | "diff" | "ai";

export const EXPLAIN_TABS: readonly ExplainTab[] = ["facts", "notes", "diff", "ai"];

export type AiExplanation =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

export type ExplainPanelState = {
  open: boolean;
  tab: ExplainTab;
  ai: AiExplanation;
};

export function initialExplainPanelState(): ExplainPanelState {
  return { open: false, tab: "facts", ai: { status: "idle" } };
}

export function toggleExplainPanel(state: ExplainPanelState): ExplainPanelState {
  return { ...state, open: !state.open };
}

export function cycleExplainTab(state: ExplainPanelState, step = 1): ExplainPanelState {
  const index = EXPLAIN_TABS.indexOf(state.tab);
  const next = (((index + step) % EXPLAIN_TABS.length) + EXPLAIN_TABS.length) % EXPLAIN_TABS.length;
  return { ...state, tab: EXPLAIN_TABS[next] };
}

export function withAiExplanation(state: ExplainPanelState, ai: AiExplanation): ExplainPanelState {
  return { ...state, ai };
}

export type ExplainRow = { text: string; bold?: boolean; dim?: boolean; color?: string };

const TAB_LABELS: Record<ExplainTab, string> = { facts: "Structure", notes: "Notes", diff: "Diff", ai: "AI" };

/** The tab strip at the top of the panel — the same "[active]" convention `tabs.ts` uses for tabs. */
function tabStrip(active: ExplainTab): ExplainRow {
  const text = EXPLAIN_TABS.map((tab) => (tab === active ? `[${TAB_LABELS[tab]}]` : ` ${TAB_LABELS[tab]} `)).join(" ");
  return { text, bold: true };
}

/**
 * The panel's own hint line, kept inside the panel rather than fought over with the editor's key
 * bar — the two have separate width budgets, and the panel's shortcuts are meaningless once it is
 * closed, so they belong with the thing they operate rather than on the code pane's chrome.
 */
function hintRow(active: ExplainTab): ExplainRow {
  const ask = active === "ai" ? "   ? ask" : "";
  return { text: `[ ] tabs   ^E close${ask}`, dim: true };
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const rows: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > width && line) {
      rows.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) rows.push(line);
  return rows.length > 0 ? rows : [""];
}

function factsRows(facts: StructuralFacts, width: number): ExplainRow[] {
  const section = (title: string, entries: StructuralFact[]): ExplainRow[] => {
    if (entries.length === 0) return [];
    return [
      { text: title, bold: true },
      ...entries.slice(0, 40).map((entry) => ({ text: `  ${String(entry.line).padStart(4)}  ${entry.text}`.slice(0, width) })),
      { text: "" },
    ];
  };
  const rows = [
    ...section("Imports", facts.imports),
    ...section("Exports", facts.exports),
    ...section("Classes", facts.classes),
    ...section("Functions", facts.functions),
  ];
  if (rows.length === 0) return [{ text: "No imports, exports, functions or classes recognised.", dim: true }];
  return rows.slice(0, -1);
}

function notesRows(notes: Annotation[], width: number): ExplainRow[] {
  if (notes.length === 0) return [{ text: "Nothing flagged.", dim: true }];
  return notes.slice(0, 60).map((entry) => ({
    text: `${String(entry.line).padStart(4)}  ${entry.note}`.slice(0, width),
    color: entry.severity === "warn" ? "yellow" : undefined,
  }));
}

function diffRows(diff: readonly DiffLine[], width: number): ExplainRow[] {
  if (diff.length === 0 || diff.every((line) => line.kind === "context")) {
    return [{ text: "No changes yet.", dim: true }];
  }
  return diff
    .filter((line) => line.kind !== "context")
    .slice(0, 200)
    .map((line) => ({
      text: `${line.kind === "add" ? "+" : "-"} ${line.text}`.slice(0, width),
      color: line.kind === "add" ? "green" : "red",
    }));
}

function aiRows(ai: AiExplanation, width: number): ExplainRow[] {
  switch (ai.status) {
    case "idle": return [{ text: "Press ? to ask the model to explain this file.", dim: true }];
    case "loading": return [{ text: "Thinking…", dim: true }];
    case "error": return [{ text: `Could not get an explanation: ${ai.message}`, color: "red" }];
    case "ready": return ai.text.split("\n").flatMap((line) => wrap(line, width)).map((text) => ({ text }));
  }
}

/**
 * The whole panel as styled rows, sized to fit next to the code pane.
 *
 * `before`/`after` are the document as it was opened and as it stands now — the same two strings
 * `renderFileChange` diffs for a tool call, here diffed for a person's own edits so leaving the diff
 * tab open answers "what have I changed" without a trip to a shell.
 */
export function composeExplainPanel(
  input: { path: string; before: string; after: string; panel: ExplainPanelState },
  width: number,
  height: number,
): ExplainRow[] {
  const body: ExplainRow[] = (() => {
    switch (input.panel.tab) {
      case "facts": return factsRows(structuralFacts(input.after, input.path), width);
      case "notes": return notesRows(annotateLines(input.after), width);
      case "diff": return diffRows(diffLines(input.before, input.after), width);
      case "ai": return aiRows(input.panel.ai, width);
    }
  })();

  const rows: ExplainRow[] = [tabStrip(input.panel.tab), hintRow(input.panel.tab), { text: "" }, ...body];
  const padded = rows.length >= height ? rows.slice(0, height) : [...rows, ...Array.from({ length: height - rows.length }, () => ({ text: "" }))];
  return padded;
}
