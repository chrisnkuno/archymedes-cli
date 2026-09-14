import type { ProviderId } from "@archymedes/core/providers/agent-matrix";
import { convertTo, formatMoney, type Currency, type FxRate } from "@archymedes/core/money";
import { mergedEnvironment, type ArchymedesSettings, type SettingKey } from "../platform/settings";
import { buildModelCatalog, describePrice, matchModelQuery, type ModelChoice, type ModelCommand } from "../session/models";
import type { GlyphSet } from "../text/glyphs";
import { buildPickerRows } from "../ui/model-picker";
import { openModelPicker, openTable, type KeyboardHost } from "../ui/shortcuts";
import { INITIAL_TABLE_STATE, renderTable } from "../ui/table";
import { buildModelTable } from "../ui/tables";

type SurfacePaint = Parameters<typeof buildModelTable>[1]["paint"];

export type ModelChooserContext = {
  environment: Record<string, string | undefined>;
  liveModels(): Partial<Record<ProviderId, readonly string[]>>;
  refreshLiveModels(options: { refresh?: boolean }): Promise<{ errors: string[] }>;
  current: { provider: ProviderId; model: string };
  display: Currency;
  rates: readonly FxRate[];
  /** The keyboard to borrow for the picker and table; omitted when nobody is at the terminal. */
  host?: KeyboardHost;
  write(text: string): void;
  paint: SurfacePaint & { yellow(text: string): string; dim(text: string): string };
  glyphs: GlyphSet;
  width: number;
};

/** What `/model` or `/models` asked for: a provider/model to switch to, settings, or nothing. */
export type ModelChoiceOutcome =
  | { kind: "switch"; provider?: string; model?: string }
  | { kind: "settings" }
  | { kind: "none" };

/**
 * Resolves a `/model` command to a target without changing the session. `/models refresh` is the
 * only path that waits on the network; a bare `/models` opens the picker, whose `t` key flips to a
 * sortable table and back, or prints the table when there is no keyboard.
 */
export async function chooseModel(command: ModelCommand, context: ModelChooserContext): Promise<ModelChoiceOutcome> {
  const { paint, write } = context;
  const wantsRefresh = command.kind === "refresh";
  if (wantsRefresh || Object.keys(context.liveModels()).length === 0) {
    if (wantsRefresh) write(paint.dim("  asking every provider what it has…\n"));
    const { errors } = await context.refreshLiveModels(wantsRefresh ? { refresh: true } : {});
    for (const error of errors) write(paint.yellow(`  ${error}\n`));
  }
  const catalog = buildModelCatalog(context.environment, undefined, context.liveModels());
  const convert = (money: { currency: Currency; micros: number }) => convertTo(money, context.display, context.rates as FxRate[]);
  const price = (choice: ModelChoice) => describePrice(choice.prices, context.display, convert);
  // One side of a price as a bare, unpainted figure, so a table column sorts by value.
  const rate = (choice: ModelChoice, side: "input" | "output"): string => {
    if (!choice.prices) return "";
    const own = { currency: choice.prices.currency, micros: side === "input" ? choice.prices.inputPerMillion : choice.prices.outputPerMillion };
    return formatMoney(convert(own) ?? own);
  };

  if (command.kind === "list" || command.kind === "refresh") {
    if (catalog.choices.length === 0) {
      write(paint.yellow("  No provider is configured yet — opening settings.\n"));
      return { kind: "settings" };
    }
    const modelTable = () => buildModelTable(catalog, { current: context.current, rate, paint, glyphs: context.glyphs });
    if (!context.host) {
      const printed = modelTable();
      write(`${renderTable(printed.columns, printed.rows, INITIAL_TABLE_STATE, { paint, width: context.width, glyphs: context.glyphs, legend: "", cursor: false })}\n`);
      for (const note of printed.notes ?? []) write(`  ${note}\n`);
      return { kind: "none" };
    }
    for (;;) {
      const chosen = await openModelPicker(context.host, { rows: buildPickerRows(catalog), current: context.current, price, paint, glyphs: context.glyphs });
      if (!chosen) { write(paint.dim("  no change\n")); return { kind: "none" }; }
      if (chosen.kind === "settings") return { kind: "settings" };
      if (chosen.kind === "model") return { kind: "switch", provider: chosen.choice.provider, model: chosen.choice.model };
      // The table view: Escape comes back to the menu, which is what a view toggle implies.
      const browsed = modelTable();
      const row = await openTable(context.host, {
        columns: browsed.columns,
        rows: browsed.rows,
        paint,
        glyphs: context.glyphs,
        title: "models · by any column you like",
        height: 12,
        initialIndex: Math.max(0, catalog.choices.findIndex((choice) => choice.provider === context.current.provider && choice.model === context.current.model)),
      });
      // `sortRows` preserves references, so the model a row stands for is found by identity.
      const fromTable = row ? catalog.choices[browsed.rows.indexOf(row)] : undefined;
      if (fromTable) return { kind: "switch", provider: fromTable.provider, model: fromTable.model };
    }
  }
  if (command.kind === "pick") {
    const chosen = catalog.choices[command.index - 1];
    if (!chosen) { write(paint.yellow(`  There is no model ${command.index}. Run /models to see the list.\n`)); return { kind: "none" }; }
    return { kind: "switch", provider: chosen.provider, model: chosen.model };
  }
  if (command.kind === "query") {
    const found = matchModelQuery(catalog, command.text);
    if (found.kind === "none") { write(paint.yellow(`  No configured model matches "${command.text}". Run /models to see the list.\n`)); return { kind: "none" }; }
    if (found.kind === "ambiguous") {
      // Naming the candidates makes the retry a copy rather than another guess.
      write(paint.yellow(`  "${command.text}" matches ${found.candidates.length} models: ${found.candidates.map((choice) => choice.model).join(", ")}.\n`));
      return { kind: "none" };
    }
    return { kind: "switch", provider: found.choice.provider, model: found.choice.model };
  }
  return { kind: "switch", provider: command.provider, model: command.model };
}

/**
 * Saves a switched-to provider and model as the default. Both halves are written: the model alone
 * would be re-read under whatever provider sorted first. An environment variable outranks the file,
 * so a save it shadows says so rather than silently changing nothing about the next launch.
 */
export async function rememberModelChoice(
  settings: ArchymedesSettings,
  provider: { id: ProviderId; envPrefix: string },
  model: string,
  processEnvironment: Record<string, string | undefined>,
  save: (settings: ArchymedesSettings, environment: Record<string, string | undefined>) => Promise<unknown>,
): Promise<{ settings: ArchymedesSettings; environment?: Record<string, string | undefined>; note: string }> {
  const modelKey = `${provider.envPrefix}_MODEL` as SettingKey;
  const next = { ...settings, ARCHYMEDES_PROVIDER: provider.id, [modelKey]: model };
  try {
    await save(next, processEnvironment);
    const shadowed = [modelKey, "ARCHYMEDES_PROVIDER"].filter((key) => processEnvironment[key]?.trim());
    const note = shadowed.length > 0
      ? ` · saved, but ${shadowed.join(" and ")} in your environment will override it next launch`
      : " · saved as your default";
    return { settings: next, environment: mergedEnvironment(next, processEnvironment), note };
  } catch {
    // The switch already happened and holds for this session; only remembering it failed.
    return { settings: next, note: " · could not save it as your default" };
  }
}
