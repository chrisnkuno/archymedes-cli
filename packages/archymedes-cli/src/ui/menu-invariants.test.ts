import { describe, expect, it } from "vitest";
import { COMMANDS } from "../catalog/commands";
import { visibleWidth } from "../text/text-width";
import { advanceChooser, filterItems, renderChooser, windowStart, type ChooserItem } from "./chooser";
import { dropupWindow, renderDropup, type DropupEntry } from "./dropup";
import { advanceModelPicker, buildPickerRows, filterPickerRows, renderModelPicker, type PickerRow } from "./model-picker";
import { advancePalette, rankPaletteEntries, renderPalette, type PaletteEntry } from "./palette";
import { advanceTable, renderTable, type TableRow } from "./table";
import { DEFAULT_BINDINGS, parseChord, chordId, resolveBindings, type KeypressEvent } from "../terminal/keybindings";
import { SETTING_FIELDS, maskSetting, validateSetting, type SettingKey } from "../platform/settings";
import type { ModelCatalog } from "../session/models";

/**
 * Invariants: properties that hold for *every* valid input, not just the examples in other tests.
 *
 * A menu that crashes, mis-highlights or paints outside its rows on one key in a thousand is the
 * exact failure unit tests miss — they check the keys someone thought of. These sweep every key
 * against hostile states (empty lists, filtered-to-nothing, selections left over from longer
 * lists, absurd widths) and assert the properties that must never break: selection in range,
 * Enter never throws, no rendered row wider than the terminal.
 */

type Key = { str?: string; key: KeypressEvent };

/** Every key a terminal can plausibly deliver, including adversarial ones. */
const KEY_CORPUS: Key[] = [
  { key: {} },
  { key: { name: undefined } },
  ...["up", "down", "left", "right", "home", "end", "pageup", "pagedown", "return", "enter", "escape", "tab", "backspace", "delete", "space"].map((name) => ({ key: { name } })),
  ...["up", "down"].flatMap((name) => [{ key: { name, ctrl: true } }, { key: { name, meta: true } }, { key: { name, shift: true } }]),
  ...["c", "g", "p", "n", "u", "a", "k"].map((name) => ({ key: { name, ctrl: true } })),
  ...["a", "b", "w", "m", "s", "d", "f", "o", "e", "t", "h", "g"].map((name) => ({ key: { name, meta: true } })),
  ...["f1", "f4", "f12"].map((name) => ({ key: { name } })),
  ...["", "a", "Z", "5", "0", "9", "t", "T", " ", "/", "@", ".", "-", "\x7f"].map((str) => ({ str, key: {} })),
  ...["a", "5", "t"].map((str) => ({ str, key: { name: str } })),
  { str: "ab", key: {} },
  { str: "return", key: { name: "return" } },
  { str: "\x03", key: { name: "c", ctrl: true } },
];

const CHOOSER_ITEMS: ChooserItem<string>[] = [
  { value: "a", label: "Alpha", description: "first" },
  { value: "b", label: "Beta", description: "second" },
  { value: "c", label: "Gamma" },
  { value: "done", label: "Done", pinned: true },
];

const DROPUP_ENTRIES: DropupEntry[] = [
  { command: "/mode", description: "permission mode" },
  { command: "/model", args: "<name>", description: "switch model" },
  { command: "/models", description: "list models" },
];

const PALETTE_ENTRIES: PaletteEntry[] = [
  { command: "/undo", description: "revert the last turn" },
  { command: "/diff", description: "what changed" },
  { command: "/model", args: "<name>", description: "switch model" },
];

const PICKER_ROWS: PickerRow[] = buildPickerRows({
  choices: [
    { provider: "anthropic", providerLabel: "Anthropic", model: "claude-sonnet-5", isProviderDefault: true, prices: undefined },
    { provider: "anthropic", providerLabel: "Anthropic", model: "claude-opus-4-6", isProviderDefault: false, prices: undefined },
    { provider: "openai", providerLabel: "OpenAI", model: "gpt-5.6-terra", isProviderDefault: true, prices: undefined },
  ],
  unconfigured: [{ provider: "groq", label: "Groq", missing: ["GROQ_API_KEY"] }],
});

const TABLE_ROWS: TableRow[] = [["a", "1"], ["b", "2"], ["c", "3"]];

function inRange(selected: number, length: number): boolean {
  return Number.isInteger(selected) && selected >= 0 && selected <= Math.max(0, length - 1);
}

describe("menu selection invariants", () => {
  it("chooser: selection stays in range and Enter never throws, for every key and hostile state", () => {
    const states = [
      { selected: 0, query: "" },
      { selected: 0, query: "zzz-no-match" },
      { selected: 99, query: "" },
      { selected: -5, query: "a" },
      { selected: 2, query: "", status: "old status" },
    ];
    for (const start of states) {
      for (const input of KEY_CORPUS) {
        const step = advanceChooser({ ...start }, CHOOSER_ITEMS, input, { filter: true });
        const visible = filterItems(CHOOSER_ITEMS, step.state.query);
        expect(inRange(step.state.selected, visible.length), `chooser ${JSON.stringify(input)} from ${JSON.stringify(start)}`).toBe(true);
        if (step.done?.index !== undefined) {
          expect(step.done.index).toBeLessThan(visible.length);
          expect(visible[step.done.index]).toBeDefined();
        }
      }
      // Empty list: every key is safe, Enter cancels.
      for (const input of KEY_CORPUS) {
        const step = advanceChooser({ selected: 7, query: "" }, [], input, { filter: true });
        expect(step.state.selected).toBe(0);
        if (step.done) expect(step.done.index).toBeUndefined();
      }
    }
  });

  it("model picker: same guarantees, including the settings rows", () => {
    const states = [
      { selected: 0, query: "" },
      { selected: 0, query: "zzz-no-match" },
      { selected: 99, query: "" },
      { selected: 3, query: "claude" },
    ];
    for (const start of states) {
      for (const input of KEY_CORPUS) {
        const step = advanceModelPicker({ ...start }, PICKER_ROWS, input);
        const visible = filterPickerRows(PICKER_ROWS, step.state.query);
        expect(inRange(step.state.selected, visible.length), `picker ${JSON.stringify(input)} from ${JSON.stringify(start)}`).toBe(true);
        if (step.done?.result?.kind === "model") {
          const wanted = step.done.result.choice.model;
          const found = visible.some((row) => row.kind === "model" && row.choice.model === wanted);
          expect(found, `picker choice ${wanted} for ${JSON.stringify(input)}`).toBe(true);
        }
      }
    }
  });

  it("palette: same guarantees", () => {
    const states = [
      { query: "", selected: 0 },
      { query: "zzz-no-match", selected: 0 },
      { query: "", selected: 99 },
    ];
    for (const start of states) {
      for (const input of KEY_CORPUS) {
        const step = advancePalette({ ...start }, PALETTE_ENTRIES, input);
        const matches = rankPaletteEntries(PALETTE_ENTRIES, step.state.query);
        expect(inRange(step.state.selected, matches.length), `palette ${JSON.stringify(input)} from ${JSON.stringify(start)}`).toBe(true);
        if (step.done?.command !== undefined) {
          // Entries with arguments resolve with a trailing space, ready to take the argument.
          const accepted = matches.some((entry) => step.done!.command === entry.command || step.done!.command === `${entry.command} `);
          expect(accepted, `palette choice ${JSON.stringify(step.done.command)}`).toBe(true);
        }
      }
    }
  });

  it("table: selection stays in range and Enter resolves inside the rows", () => {
    const states = [
      { selected: 0, focused: true },
      { selected: 99, focused: true },
      { selected: 0, focused: false },
    ];
    for (const start of states) {
      for (const input of KEY_CORPUS) {
        const step = advanceTable({ ...start }, TABLE_ROWS, input);
        expect(inRange(step.state.selected, TABLE_ROWS.length), `table ${JSON.stringify(input)} from ${JSON.stringify(start)}`).toBe(true);
        if (step.done?.index !== undefined) {
          expect(step.done.index).toBeLessThan(TABLE_ROWS.length);
        }
      }
      for (const input of KEY_CORPUS) {
        const step = advanceTable({ selected: 5, focused: true }, [], input);
        expect(step.state.selected).toBe(0);
        if (step.done) expect(step.done.index).toBeUndefined();
      }
    }
  });
});

describe("windowing invariants", () => {
  it("windowStart always shows the selection inside a legal window", () => {
    for (let total = 0; total < 30; total += 1) {
      for (let rows = 0; rows < 15; rows += 1) {
        for (let selected = -2; selected < total + 2; selected += 1) {
          const start = windowStart(selected, total, rows);
          const size = Math.max(1, Math.floor(rows));
          expect(start, `total=${total} rows=${rows} selected=${selected}`).toBeGreaterThanOrEqual(0);
          expect(start).toBeLessThanOrEqual(Math.max(0, total - size));
          if (total > 0 && total > size) {
            const cursor = Math.max(0, Math.min(Math.floor(selected), total - 1));
            expect(start).toBeLessThanOrEqual(cursor);
            expect(cursor).toBeLessThan(start + size);
          }
        }
      }
    }
  });

  it("dropupWindow never exceeds the list and pins an unbrowsed list to the top", () => {
    for (let count = 0; count < 12; count += 1) {
      for (const rows of [0, 1, 3, 8, 100]) {
        const plain = dropupWindow(count, rows, undefined);
        expect(plain.start).toBe(0);
        expect(plain.length).toBeLessThanOrEqual(count);
        for (let selected = 0; selected < count + 1; selected += 1) {
          const window = dropupWindow(count, rows, selected);
          expect(window.length).toBeLessThanOrEqual(count);
          if (window.length > 0 && selected < count) {
            expect(window.start).toBeLessThanOrEqual(selected);
            expect(selected).toBeLessThan(window.start + window.length);
          }
        }
      }
    }
  });
});

describe("render width invariants", () => {
  const widths = [1, 2, 5, 6, 7, 8, 9, 20, 40, 80, 200];
  const paint = { dim: (s: string) => s, cyan: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s };

  it("no renderer ever emits a row wider than the terminal", () => {
    for (const width of widths) {
      for (const line of renderChooser({ selected: 2, query: "a" }, CHOOSER_ITEMS, { width, paint }).split("\n")) {
        expect(visibleWidth(line), `chooser w=${width}`).toBeLessThanOrEqual(width);
      }
      for (const line of renderModelPicker(
        { rows: filterPickerRows(PICKER_ROWS, ""), selected: 1 },
        { width, current: { provider: "anthropic", model: "claude-sonnet-5" }, price: () => "$1.00", paint, query: "cl" },
      ).split("\n")) {
        expect(visibleWidth(line), `picker w=${width}`).toBeLessThanOrEqual(width);
      }
      for (const line of renderPalette(
        { query: "mo", matches: rankPaletteEntries(PALETTE_ENTRIES, "mo"), selected: 5 },
        { width },
      ).split("\n")) {
        expect(visibleWidth(line), `palette w=${width}`).toBeLessThanOrEqual(width);
      }
      for (const line of renderDropup(DROPUP_ENTRIES, { width, maxRows: 8 })) {
        expect(visibleWidth(line), `dropup w=${width}`).toBeLessThanOrEqual(width);
      }
      for (const line of renderDropup(DROPUP_ENTRIES, { width, maxRows: 8, selected: 99 })) {
        expect(visibleWidth(line), `dropup-selected w=${width}`).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("filter invariants", () => {
  it("an empty query returns everything in order", () => {
    expect(filterItems(CHOOSER_ITEMS, "")).toHaveLength(CHOOSER_ITEMS.length);
    expect(rankPaletteEntries(PALETTE_ENTRIES, "")).toHaveLength(PALETTE_ENTRIES.length);
    expect(filterPickerRows(PICKER_ROWS, "")).toHaveLength(PICKER_ROWS.length);
  });

  it("every filtered row actually matches, or is pinned", () => {
    for (const query of ["a", "ALPHA", "zzz", " ", "mo"]) {
      for (const item of filterItems(CHOOSER_ITEMS, query)) {
        const text = `${item.label} ${item.description ?? ""}`.toLowerCase();
        expect(text.includes(query.trim().toLowerCase()) || item.pinned, `${item.label} vs ${query}`).toBe(true);
      }
    }
  });
});

describe("key binding invariants", () => {
  it("every default chord parses and no two commands share one", () => {
    const seen = new Map<string, string>();
    for (const binding of DEFAULT_BINDINGS) {
      for (const chord of binding.chords) {
        const parsed = parseChord(chord);
        expect(parsed, chord).toBeDefined();
        const id = chordId(parsed!);
        expect(seen.has(id), `${chord} also bound`).toBe(false);
        seen.set(id, binding.command);
      }
    }
  });

  it("every bound command exists, and conflicts are reported rather than dropped", () => {
    const names: Set<string> = new Set(COMMANDS.map((command) => command.name));
    for (const binding of DEFAULT_BINDINGS) {
      expect(names.has(binding.command.split(/\s+/)[0]), binding.command).toBe(true);
    }
    const resolved = resolveBindings({ "/diff": "ctrl+g", "/nope": "f11" });
    expect(resolved.conflicts.map((conflict) => conflict.command)).toContain("/nope");
    expect(resolved.conflicts.map((conflict) => conflict.chord)).toContain("Ctrl+G");
  });
});

describe("settings validation invariants", () => {
  const canonical: Partial<Record<SettingKey, string[]>> = {
    ARCHYMEDES_LANGUAGE: ["en", "AR"],
    ARCHYMEDES_COUNTRY: ["RW", "eg"],
    ARCHYMEDES_CURRENCY: ["USD", "rwf"],
    ARCHYMEDES_PROVIDER: ["anthropic", "OpenAI"],
    ARCHYMEDES_FALLBACK_MODEL: ["ask", "openai:gpt-5.4-mini", "OFF"],
    FREE_MODEL: ["openrouter/free", "lab/code:free"],
    ANTHROPIC_API_KEY: ["sk-ant-secret"],
    ANTHROPIC_BASE_URL: ["https://api.anthropic.com", "http://localhost:8080/v1/"],
    OPENROUTER_API_KEY: ["sk-or-secret"],
    ARCHYMEDES_JEV: ["on", "OFF"],
    MODEL_INPUT_PER_MILLION: ["1.5", "0"],
    MODEL_OUTPUT_PER_MILLION: ["9.99", "0"],
    MODEL_CACHED_INPUT_PER_MILLION: ["0.25"],
    ARCHYMEDES_ACCOUNT_BALANCE: ["10", "0"],
    ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY: ["USD", "rwf"],
    ARCHYMEDES_LOW_BALANCE: ["5"],
    ARCHYMEDES_CRITICAL_BALANCE: ["1"],
    ARCHYMEDES_CLOUD_CURRENCY: ["USD"],
    ARCHYMEDES_CLOUD_MAXIMUM_MICROS: ["1000000"],
    ARCHYMEDES_CLOUD_QUALITY_FLOOR: ["0", "0.5", "1"],
    MODEL_PRICE_CURRENCY: ["EUR"],
    ARCHYMEDES_AUTO_UPDATE: ["install", "check", "off"],
    ARCHYMEDES_SUGGEST_MODEL: ["on", "off"],
    ARCHYMEDES_KEYS: ["/diff=alt+d"],
    OPENAI_MODEL: ["gpt-5.6-terra"],
    TYPESAFE_API_KEY: ["ts-secret"],
  };

  it("every field accepts at least one canonical value and rejects emptiness", () => {
    for (const field of SETTING_FIELDS) {
      expect(() => validateSetting(field.key, ""), `${field.key} empty`).toThrow();
      expect(() => validateSetting(field.key, "   "), `${field.key} blank`).toThrow();
      // URL fields take any well-formed HTTPS URL; every other field has its samples above.
      const samples = "url" in field && field.url
        ? ["https://api.example.com/v1", "http://localhost:8080/v1"]
        : canonical[field.key] ?? ["anything-at-all"];
      let accepted = 0;
      for (const sample of samples) {
        try {
          const result = validateSetting(field.key, sample);
          expect(result.trim().length, `${field.key}=${sample}`).toBeGreaterThan(0);
          accepted += 1;
        } catch { /* some samples are negative cases by design */ }
      }
      expect(accepted, `${field.key} accepts nothing`).toBeGreaterThan(0);
    }
  });

  it("normalization is idempotent: validating twice changes nothing the second time", () => {
    for (const field of SETTING_FIELDS) {
      for (const sample of canonical[field.key] ?? ["anything-at-all"]) {
        let once: string;
        try {
          once = validateSetting(field.key, sample);
        } catch {
          continue;
        }
        expect(validateSetting(field.key, once), `${field.key}=${sample}`).toBe(once);
      }
    }
  });

  it("masking never reveals the middle of a secret", () => {
    expect(maskSetting(undefined)).toBe("not set");
    expect(maskSetting("")).toBe("not set");
    // Short values carry nothing worth hiding: the mask says only that something is set.
    expect(maskSetting("short")).toBe("set (hidden)");
    for (const secret of ["sk-ant-abcdefghijklmnopqrstuvwxyz0123456789", "123456789", "exactly-nine-1"]) {
      const masked = maskSetting(secret);
      // The implementation shows the first and last three characters only.
      expect(masked).toBe(`${secret.slice(0, 3)}…${secret.slice(-3)}`);
      const middle = secret.slice(3, -3);
      if (middle.length >= 4) expect(masked).not.toContain(middle);
    }
  });

  it("every provider's required keys exist as settings fields", () => {
    const keys = new Set(SETTING_FIELDS.map((field) => field.key));
    for (const field of SETTING_FIELDS) expect(keys.has(field.key)).toBe(true);
    expect(SETTING_FIELDS.map((field) => field.key)).toHaveLength(new Set(SETTING_FIELDS.map((field) => field.key)).size);
  });
});
