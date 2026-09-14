import { describe, expect, it } from "vitest";
import { buildModelCatalog } from "../session/models";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { chooseModel, rememberModelChoice, type ModelChooserContext } from "./model";

const environment = { ANTHROPIC_API_KEY: "sk-test" };
const same = (text: string) => text;

function context(overrides: Partial<ModelChooserContext> = {}) {
  const written: string[] = [];
  const refreshes: Array<{ refresh?: boolean }> = [];
  const ctx: ModelChooserContext = {
    environment,
    liveModels: () => ({ anthropic: [] }),
    refreshLiveModels: async (options) => { refreshes.push(options); return { errors: [] }; },
    current: { provider: "anthropic", model: "none" },
    display: "USD",
    rates: [],
    write: (text) => written.push(text),
    paint: { dim: same, cyan: same, green: same, yellow: same, bold: same },
    glyphs: UNICODE_GLYPHS,
    width: 100,
    ...overrides,
  };
  return { ctx, written, refreshes };
}

describe("/model", () => {
  const first = buildModelCatalog(environment).choices[0];

  it("prints the model table when there is no keyboard, refreshing only when asked", async () => {
    const { ctx, written, refreshes } = context();
    expect(await chooseModel({ kind: "list" }, ctx)).toEqual({ kind: "none" });
    expect(written.join("")).toContain(first.model);
    expect(refreshes).toEqual([]);
    const refreshing = context();
    await chooseModel({ kind: "refresh" }, refreshing.ctx);
    expect(refreshing.refreshes).toEqual([{ refresh: true }]);
  });

  it("resolves a list index, a query and an explicit target, and explains misses", async () => {
    expect(await chooseModel({ kind: "pick", index: 1 }, context().ctx)).toEqual({ kind: "switch", provider: first.provider, model: first.model });
    const missing = context();
    expect(await chooseModel({ kind: "pick", index: 999 }, missing.ctx)).toEqual({ kind: "none" });
    expect(missing.written.join("")).toContain("There is no model 999");
    expect(await chooseModel({ kind: "query", text: first.model }, context().ctx)).toMatchObject({ kind: "switch", model: first.model });
    const nothing = context();
    expect(await chooseModel({ kind: "query", text: "no-such-model-anywhere" }, nothing.ctx)).toEqual({ kind: "none" });
    expect(nothing.written.join("")).toContain("No configured model matches");
    expect(await chooseModel({ kind: "explicit", provider: "openai", model: "x" }, context().ctx)).toEqual({ kind: "switch", provider: "openai", model: "x" });
  });

  it("still lists the keyless local provider when no API key is configured", async () => {
    const { ctx, written } = context({ environment: {} });
    expect(await chooseModel({ kind: "list" }, ctx)).toEqual({ kind: "none" });
    expect(written.join("").toLowerCase()).toContain("ollama");
  });

  it("remembers the choice, says when the environment shadows it, and survives a failed save", async () => {
    const provider = { id: "anthropic" as const, envPrefix: "ANTHROPIC" };
    const saved = await rememberModelChoice({}, provider, "claude-x", {}, async () => undefined);
    expect(saved.settings).toMatchObject({ ARCHYMEDES_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-x" });
    expect(saved.note).toBe(" · saved as your default");
    expect(saved.environment?.ANTHROPIC_MODEL).toBe("claude-x");
    const shadowed = await rememberModelChoice({}, provider, "claude-x", { ANTHROPIC_MODEL: "other" }, async () => undefined);
    expect(shadowed.note).toContain("ANTHROPIC_MODEL in your environment will override it");
    const failed = await rememberModelChoice({}, provider, "claude-x", {}, async () => { throw new Error("read-only"); });
    expect(failed).toEqual({ settings: { ARCHYMEDES_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-x" }, note: " · could not save it as your default" });
  });
});
