import { describe, expect, it } from "vitest";
import { advanceModelPicker, buildPickerRows, filterPickerRows, initialSelection, renderModelPicker, runModelPicker, type PickerRow } from "./model-picker";
import { buildModelCatalog } from "../session/models";
import type { KeypressEvent } from "../terminal/keybindings";
import { visibleWidth } from "../text/text-width";

const paint = { dim: (text: string) => text, cyan: (text: string) => text, green: (text: string) => text, yellow: (text: string) => text };
const configured = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", DEEPSEEK_API_KEY: "k" };
const current = { provider: "anthropic" as const, model: "claude-sonnet-5" };
const options = { current, price: () => "$2/$10 per Mtok", paint };

const press = (name: string, key: Partial<KeypressEvent> = {}, str?: string) => ({ ...(str === undefined ? {} : { str }), key: { name, ...key } as KeypressEvent });
const type = (text: string) => [...text].map((char) => press(char, {}, char));

describe("the picker's rows", () => {
  it("offers every switchable model, then a way to fix what is missing", () => {
    const rows = buildPickerRows(buildModelCatalog({ ANTHROPIC_API_KEY: "k" }, "2026-08-10"));
    const models = rows.filter((row) => row.kind === "model");
    const settings = rows.filter((row) => row.kind === "settings");

    expect(models.length).toBeGreaterThan(0);
    // One row for every unconfigured provider, plus the general settings row.
    expect(settings).toHaveLength(11);
    expect(rows.at(-1)).toMatchObject({ kind: "settings" });
  });

  it("makes an unconfigured provider a row you can act on, not a note to go elsewhere", () => {
    const rows = buildPickerRows(buildModelCatalog({ ANTHROPIC_API_KEY: "k" }, "2026-08-10"));
    const openai = rows.find((row) => row.header === "OpenAI");
    expect(openai).toMatchObject({ kind: "settings" });
    if (openai?.kind !== "settings") throw new Error("expected a settings row");
    expect(openai.label).toContain("OPENAI_API_KEY");
  });

  it("heads each provider's group once, so the list reads as groups rather than a flat wall", () => {
    const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));
    expect(rows.filter((row) => row.header === "Anthropic")).toHaveLength(1);
  });

  it("starts the cursor on the model in use", () => {
    // The common case is opening the list to look, so the cursor should already be where the
    // answer to "what am I on?" is.
    const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));
    const start = initialSelection(rows, current);
    expect(rows[start]).toMatchObject({ kind: "model", choice: { model: "claude-sonnet-5" } });
  });

  it("falls back to the first row when the current model is not in the list", () => {
    const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));
    expect(initialSelection(rows, { provider: "anthropic", model: "not-a-model" })).toBe(0);
  });
});

describe("moving around the picker", () => {
  const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));

  it("moves with the arrows and clamps at both ends", () => {
    // Wrapping past the end of a short list reads as the cursor jumping somewhere at random.
    expect(advanceModelPicker({ selected: 0, query: "" }, rows, press("up")).state.selected).toBe(0);
    expect(advanceModelPicker({ selected: 0, query: "" }, rows, press("down")).state.selected).toBe(1);
    expect(advanceModelPicker({ selected: rows.length - 1, query: "" }, rows, press("down")).state.selected).toBe(rows.length - 1);
  });

  it("still accepts a typed number, the habit the printed list taught", () => {
    expect(advanceModelPicker({ selected: 0, query: "" }, rows, press("3", {}, "3")).state.selected).toBe(2);
  });

  it("interprets a number against the visible window after scrolling", () => {
    const selected = rows.length - 1;
    const height = 4;
    const rendered = renderModelPicker({ rows, selected }, { ...options, height });
    const first = rendered.split("\n").find((line) => line.includes("1."));
    const jumped = advanceModelPicker({ selected, query: "" }, rows, press("1", {}, "1"), { height }).state.selected;
    const label = rows[jumped]?.kind === "model" ? rows[jumped].choice.model : rows[jumped]?.label;
    expect(first).toContain(label);
  });

  it("ignores a number past the end of the list", () => {
    const short: PickerRow[] = [{ kind: "settings", label: "Settings…" }];
    expect(advanceModelPicker({ selected: 0, query: "" }, short, press("9", {}, "9")).state.selected).toBe(0);
  });

  it("ignores a number the live window never displayed", () => {
    expect(advanceModelPicker({ selected: 0, query: "" }, rows, press("9", {}, "9"), { height: 4 }).state.selected).toBe(0);
  });

  it("returns the chosen model on Return", () => {
    const done = advanceModelPicker({ selected: 0, query: "" }, rows, press("return")).done;
    expect(done?.result).toMatchObject({ kind: "model", choice: { model: "claude-sonnet-5" } });
  });

  it("clamps a stale selection when Enter uses it", () => {
    const done = advanceModelPicker({ selected: rows.length + 20, query: "" }, rows, press("return")).done;
    expect(done?.result).toEqual({ kind: "settings" });
  });

  it("returns a request to open settings when a settings row is chosen", () => {
    const done = advanceModelPicker({ selected: rows.length - 1, query: "" }, rows, press("return")).done;
    expect(done?.result).toEqual({ kind: "settings" });
  });

  it("cancels on Escape and Ctrl-C, choosing nothing", () => {
    expect(advanceModelPicker({ selected: 2, query: "" }, rows, press("escape")).done).toEqual({});
    expect(advanceModelPicker({ selected: 2, query: "" }, rows, press("c", { ctrl: true })).done).toEqual({});
  });
});

describe("rendering the picker", () => {
  const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));

  it("marks the cursor and the model in use, and prices each row", () => {
    const rendered = renderModelPicker({ rows, selected: initialSelection(rows, current) }, options);
    expect(rendered).toContain("❯");
    expect(rendered).toContain("claude-sonnet-5");
    expect(rendered).toContain("per Mtok");
    expect(rendered).toContain("current");
  });

  it("keeps the selection on screen in a list longer than the window", () => {
    const rendered = renderModelPicker({ rows, selected: rows.length - 1 }, { ...options, height: 4 });
    expect(rendered).toContain("❯");
  });

  it("says how to drive it, since a menu that needs explaining elsewhere is not finished", () => {
    expect(renderModelPicker({ rows, selected: 0 }, options)).toContain("Esc");
  });

  it("shows the same window-relative number the key handler accepts", () => {
    expect(renderModelPicker({ rows, selected: 0 }, options)).toContain("1.");
  });

  it("clips long model ids, prices and settings rows at every terminal width", () => {
    const longRows: PickerRow[] = [
      { kind: "model", choice: { ...rows.find((row) => row.kind === "model")!.choice, model: "model-".repeat(30) } },
      { kind: "settings", label: "settings ".repeat(30) },
    ];
    for (const width of [1, 8, 19, 30, 80]) {
      const rendered = renderModelPicker({ rows: longRows, selected: 0 }, { ...options, width, price: () => "price ".repeat(20) });
      for (const line of rendered.split("\n")) expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
    }
  });
});

describe("the picker end to end", () => {
  async function* keys(sequence: ReturnType<typeof press>[]) {
    for (const key of sequence) yield key;
  }
  const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));

  it("moves and chooses, repainting as it goes", async () => {
    const frames: string[] = [];
    const chosen = await runModelPicker(keys([press("down"), press("return")]), (frame) => frames.push(frame), { ...options, rows });
    const expected = rows[initialSelection(rows, current) + 1];
    expect(chosen).toMatchObject({ kind: "model", choice: (expected as { choice: unknown }).choice });
    expect(frames).toHaveLength(2);
  });

  it("chooses nothing when dismissed", async () => {
    expect(await runModelPicker(keys([press("escape")]), () => {}, { ...options, rows })).toBeUndefined();
  });

  it("chooses nothing when the key stream ends, rather than switching on a closed stdin", async () => {
    expect(await runModelPicker(keys([press("down")]), () => {}, { ...options, rows })).toBeUndefined();
  });
});

describe("filtering the picker", () => {
  const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));
  const filter = (text: string) => {
    let state = { selected: 0, query: "" };
    for (const key of type(text)) state = advanceModelPicker(state, rows, key).state;
    return state;
  };
  const visibleModels = (query: string) => filterPickerRows(rows, query).filter((row) => row.kind === "model");

  it("narrows to matching models as you type", () => {
    const state = filter("sonnet");
    expect(state.query).toBe("sonnet");
    const visible = visibleModels(state.query);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(rows.length);
    for (const row of visible) {
      expect(row.kind === "model" && row.choice.model.toLowerCase()).toContain("sonnet");
    }
  });

  it("finds models by provider as well as by id", () => {
    // No model id contains "anthropic" — the provider label is the secondary search text.
    const visible = visibleModels(filter("anthropic").query);
    expect(visible.length).toBeGreaterThan(0);
    for (const row of visible) expect(row.kind === "model" && row.choice.provider).toBe("anthropic");
  });

  it("keeps the row that fixes a missing key findable by provider name", () => {
    // OpenAI is configured in this fixture, so its models match by provider label...
    const models = filterPickerRows(rows, filter("openai").query);
    expect(models.some((row) => row.kind === "model" && row.choice.provider === "openai")).toBe(true);
    // ...while xAI is not, so its fix-it row matches by key name.
    const missing = filterPickerRows(rows, filter("xai").query);
    expect(missing.some((row) => row.kind === "settings" && row.header === "xAI Grok")).toBe(true);
  });

  it("chooses from the filtered rows, not the full list underneath", async () => {
    async function* keys() {
      for (const key of type("sonnet")) yield key;
      yield press("return");
    }
    const chosen = await runModelPicker(keys(), () => {}, { ...options, rows });
    expect(chosen).toMatchObject({ kind: "model" });
    if (chosen?.kind !== "model") throw new Error("expected a model");
    expect(chosen.choice.model.toLowerCase()).toContain("sonnet");
  });

  it("types t once filtering instead of flipping to the table", () => {
    // `sonnet` without this reads as s-o-n-n-table.
    const state = filter("sonnet");
    expect(state.query).toBe("sonnet");
    expect(advanceModelPicker(state, rows, press("return")).done?.result).toMatchObject({ kind: "model" });
  });

  it("still flips to the table on t with an empty query", () => {
    expect(advanceModelPicker({ selected: 0, query: "" }, rows, press("t", {}, "t")).done?.result).toEqual({ kind: "table" });
  });

  it("types digits once filtering instead of jumping", () => {
    // "gpt-5" without this reads as g-p-t-jump.
    const state = filter("gpt-5");
    expect(state.query).toBe("gpt-5");
    const visible = visibleModels(state.query);
    expect(visible.length).toBeGreaterThan(0);
  });

  it("clears the query with Escape before cancelling with it", () => {
    const cleared = advanceModelPicker({ selected: 3, query: "opus" }, rows, press("escape"));
    expect(cleared.done).toBeUndefined();
    expect(cleared.state).toEqual({ selected: 0, query: "" });
    expect(advanceModelPicker(cleared.state, rows, press("escape")).done).toEqual({});
  });

  it("edits the query with backspace and clears it with Ctrl-U", () => {
    expect(advanceModelPicker({ selected: 0, query: "opus" }, rows, press("backspace")).state.query).toBe("opu");
    expect(advanceModelPicker({ selected: 0, query: "opus" }, rows, press("u", { ctrl: true })).state).toEqual({ selected: 0, query: "" });
  });

  it("reheads the visible groups when filtering removes rows", () => {
    const rendered = renderModelPicker(
      { rows: filterPickerRows(rows, "claude"), selected: 0 },
      { ...options, query: "claude" },
    );
    expect(rendered).toContain("filter: claude");
    expect(rendered.match(/Anthropic/g)).toHaveLength(1);
  });

  it("says no match rather than showing a stale list, and Enter then cancels", () => {
    const state = filter("zzz-no-such-model");
    const rendered = renderModelPicker({ rows: filterPickerRows(rows, state.query), selected: 0 }, { ...options, query: state.query });
    expect(rendered).toContain("(no match)");
    expect(advanceModelPicker(state, rows, press("return")).done).toEqual({});
  });

  it("pages with PageUp and PageDown like every other list", () => {
    expect(advanceModelPicker({ selected: 0, query: "" }, rows, press("pagedown"), { height: 4 }).state.selected).toBe(4);
    expect(advanceModelPicker({ selected: 3, query: "" }, rows, press("pageup"), { height: 4 }).state.selected).toBe(0);
  });
});

describe("the picker's motion", () => {
  const rows = buildPickerRows(buildModelCatalog(configured, "2026-08-10"));
  async function* keys(sequence: ReturnType<typeof press>[]) {
    for (const key of sequence) yield key;
  }
  async function* keysWithDelay(sequence: readonly (ReturnType<typeof press> | number)[]) {
    for (const item of sequence) {
      if (typeof item === "number") { await new Promise((resolve) => setTimeout(resolve, item)); continue; }
      yield item;
    }
  }

  it("marks the outgoing row alongside the incoming one during a transition", () => {
    const withTransition = renderModelPicker({ rows, selected: 1 }, { ...options, transitionFrom: 0 });
    expect((withTransition.match(/❯/g) ?? []).length).toBe(2);
    const withoutTransition = renderModelPicker({ rows, selected: 1 }, options);
    expect((withoutTransition.match(/❯/g) ?? []).length).toBe(1);
  });

  it("glides a single-step move, and never a filter keystroke or a jump", async () => {
    // Fast: the next key arrives before any settle tick, so only the transitional frame paints.
    const fast: string[] = [];
    await runModelPicker(keys([press("down"), press("return")]), (frame) => fast.push(frame), { ...options, rows });
    expect(fast).toHaveLength(2);

    // Slow: real time passes, so the glide settles through extra frames without moving any rows.
    const slow: string[] = [];
    await runModelPicker(keysWithDelay([press("down"), 150, press("return")]), (frame) => slow.push(frame), { ...options, rows, motion: true });
    expect(slow.length).toBeGreaterThan(2);
    expect(new Set(slow.map((frame) => frame.split("\n").length)).size).toBe(1);
  });
});
