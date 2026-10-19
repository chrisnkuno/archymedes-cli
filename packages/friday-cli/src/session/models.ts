import { PROVIDERS, type ProviderId } from "@archymedes/core/providers/agent-matrix";
import { PRICE_CATALOG } from "@archymedes/core/providers/price-catalog";
import { formatMoney, money, type Currency, type TokenPrices } from "@archymedes/core/money";

/**
 * Text models known to this build, per provider, in catalog order.
 *
 * The provider's own default comes first within its group: it is the one a user gets by doing
 * nothing, so it is the one they are most likely to want back.
 */
export function modelsForProvider(provider: ProviderId, asOf?: string): string[] {
  const seen = new Set<string>();
  for (const record of PRICE_CATALOG) {
    if (record.provider !== provider || record.modality !== "text" || record.billingUnit !== "tokens") continue;
    seen.add(record.model);
  }
  const fallback = PROVIDERS[provider].defaultModel;
  seen.add(fallback);
  const models = [...seen].filter((model) => model !== fallback).sort();
  void asOf;
  return [fallback, ...models];
}

/** Per-million input/output rates in the display currency, or a plain admission of not knowing. */
export function describePrice(prices: TokenPrices | undefined, display: Currency, convert: (value: { currency: Currency; micros: number }) => { currency: Currency; micros: number } | undefined): string {
  if (!prices) return "unpriced";
  const input = convert({ currency: prices.currency, micros: prices.inputPerMillion });
  const output = convert({ currency: prices.currency, micros: prices.outputPerMillion });
  if (!input || !output) {
    // Unconverted, in the provider's own currency. `money()` and not `fromUnits()`: these are
    // already micros, and multiplying them by a million again renders a 1,610 RWF rate as
    // "RWF 1,610,000,000" — a number wrong by six orders of magnitude on the fallback path nobody
    // sees until an exchange rate is missing.
    return `${formatMoney(money(prices.inputPerMillion, prices.currency))}/${formatMoney(money(prices.outputPerMillion, prices.currency))} per Mtok`;
  }
  void display;
  return `${formatMoney(input)}/${formatMoney(output)} per Mtok`;
}
