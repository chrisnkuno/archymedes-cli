import path from "node:path";
import { ArchymedesAgent } from "@archymedes/core/cli/agent";
import { glyphs, style } from "./transcript";
import { catalogPrices, describeProviders, PRICE_ENVIRONMENT_HINT } from "@archymedes/core/providers/agent-matrix";
import { convertTo, isCurrency, type Currency, type FxRate, type TokenPrices } from "@archymedes/core/money";
import { describePrice, modelsForProvider } from "../session/models";
import { detectColorDepth } from "../text/color-depth";
import { table } from "../render/tui";
import { MODEL_FIELD_PROVIDER, mergedEnvironment, type ArchymedesSettings, type SettingChoice, type SettingKey } from "../platform/settings";
import { fetchProviderModels, mergeModelLists } from "@archymedes/core/providers/model-fetch";

/**
 * Provider and price facts for the terminal session: the providers listing, FX rates from the
 * environment, and the model choices and price catalog the settings menu offers.
 */

/**
 * The setup view: what works, what is missing, and the exact variable that fixes it.
 */
export function renderProviders(environment: Record<string, string | undefined>, depth: ReturnType<typeof detectColorDepth>): string {
  // The banner honours NO_COLOR; this view has to as well, or `archymedes --providers > setup.txt`
  // writes escape codes into the file someone is about to read.
  const paint = (text: string, apply: (value: string) => string) => (depth === "none" ? text : apply(text));
  const statuses = describeProviders(environment);
  const rows: string[][] = [];

  for (const status of statuses) {
    const mark = status.configured ? paint(glyphs.check, style.green) : paint(glyphs.circleEmpty, style.dim);
    const detail = status.configured
      ? paint(`${status.model} · pricing: ${status.pricing}`, style.dim)
      // `archymedes settings` leads: it stores the key for next time, where an exported variable lives
      // only as long as the shell does. The variable name still appears, for CI and containers.
      : paint(`archymedes settings, or set ${status.missing.join(" and ")}`, style.yellow);
    rows.push([mark, status.label, detail]);
  }
  const exaConfigured = Boolean(environment.EXA_API_KEY?.trim());
  rows.push([
    exaConfigured ? paint(glyphs.check, style.green) : paint(glyphs.circleEmpty, style.dim),
    "Exa search",
    exaConfigured ? paint("web_search enabled", style.dim) : paint("archymedes settings, or set EXA_API_KEY", style.yellow),
  ]);
  const lines: string[] = [table(["", "provider", "status"], rows, { depth, glyphs })];

  const unpriced = statuses.filter((status) => status.configured && status.pricing === "unknown");
  if (unpriced.length > 0) {
    lines.push("");
    lines.push(paint(`  No published price for ${unpriced.map((status) => status.model).join(", ")} — costs show as unknown.`, style.dim));
    lines.push(paint(`  Set ${PRICE_ENVIRONMENT_HINT} to price it.`, style.dim));
  }
  if (readFxRates(environment).length === 0) {
    lines.push(paint("  Set ARCHYMEDES_FX_FROM / ARCHYMEDES_FX_TO / ARCHYMEDES_FX_RATE to price models in another currency offline.", style.dim));
  }
  return lines.join("\n");
}

export function readFxRates(environment: Record<string, string | undefined>): FxRate[] {
  const genericRate = Number(environment.ARCHYMEDES_FX_RATE);
  const genericFrom = environment.ARCHYMEDES_FX_FROM?.trim().toUpperCase();
  const genericTo = environment.ARCHYMEDES_FX_TO?.trim().toUpperCase();
  const configured: FxRate[] = [];
  if (Number.isFinite(genericRate) && genericRate > 0 && genericFrom && genericTo && isCurrency(genericFrom) && isCurrency(genericTo) && genericFrom !== genericTo) {
    configured.push({
      from: genericFrom,
      to: genericTo,
      rate: genericRate,
      asOf: environment.ARCHYMEDES_FX_ASOF?.trim() || new Date().toISOString().slice(0, 10),
      source: environment.ARCHYMEDES_FX_SOURCE?.trim() || "ARCHYMEDES_FX_RATE",
    });
  }
  return configured;
}

/**
 * `ModelPriceCatalog` for the runtime's own runaway guard, from the ledger's `TokenPrices`.
 *
 * The two exist for different readers. `TokenPrices` is what the ledger and the display report
 * are built on — currency-aware, dated, converted for a human. `ModelPriceCatalog` is a bare
 * integer rate `ArchymedesAgent` compares a running total against before every provider call, and it has
 * always used a coarser unit than the ledger by design: an approved cap switches to full
 * currency-micros precision so the runtime can clamp accurately against a real promise made to the
 * user, while the common case (no explicit cap) uses whole-currency-units-per-million as a loose
 * backstop, because a guard rail nobody configured should be generous rather than surprising.
 */
/**
 * What a model field in the settings menu should offer, asked of the provider itself.
 *
 * A model id is the one setting whose valid answers Archymedes cannot know: they belong to the provider,
 * they change with no release of Archymedes, and the key needed to ask for them has — by the time this
 * field is opened — just been typed into the field above. So this asks, using the settings as they
 * stand in the menu rather than as they were saved, which is what makes "paste a key, then pick a
 * model" work in one visit instead of two.
 *
 * The catalog stays underneath: it is what knows prices, and it is the whole list when there is no
 * key yet or the provider cannot be reached. The fetch only ever widens it, and never blocks on
 * more than one provider — the one whose field is open.
 */
export async function modelChoicesForSettingsField(
  field: SettingKey,
  settings: ArchymedesSettings,
  processEnvironment: Record<string, string | undefined>,
  display: Currency,
  rates: readonly FxRate[],
): Promise<readonly SettingChoice[]> {
  const provider = MODEL_FIELD_PROVIDER[field];
  if (!provider) return [];
  // The in-progress menu values win over the process environment, so a key pasted a moment ago is
  // the key this asks with.
  const environment = mergedEnvironment(settings, processEnvironment);
  const known = modelsForProvider(provider);
  const fetched = await fetchProviderModels(provider, environment, globalThis.fetch as never).catch(() => null);
  const models = mergeModelLists(known, fetched?.models);

  return models.map((model) => {
    const prices = catalogPrices(provider, model);
    return {
      value: model,
      label: model,
      // Named rather than left blank: a model this build has no rate for is perfectly usable, and
      // saying so is different from saying nothing — the cost report will say the same thing later.
      description: prices
        ? describePrice(prices, display, (amount) => convertTo(amount, display, rates))
        : "no published rate — costs will show as unknown",
    };
  });
}

export function modelPriceCatalogFor(prices: Pick<TokenPrices, "inputPerMillion" | "outputPerMillion" | "largeContext"> | undefined, exact: boolean) {
  if (!prices) return { inputRatePerMillion: 1, outputRatePerMillion: 1 };
  const rates = exact
    ? { inputRatePerMillion: prices.inputPerMillion, outputRatePerMillion: prices.outputPerMillion }
    : { inputRatePerMillion: Math.max(1, Math.round(prices.inputPerMillion / 1_000_000)), outputRatePerMillion: Math.max(1, Math.round(prices.outputPerMillion / 1_000_000)) };
  return { ...rates, ...(prices.largeContext ? { largeContext: prices.largeContext } : {}) };
}
