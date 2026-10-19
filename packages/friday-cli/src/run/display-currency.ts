/**
 * The currency a session reports costs in, and the exchange rates behind it.
 *
 * Moved out of `main()` unchanged. The display currency is a value the session keeps changing — a
 * late rate can land after startup, and `/settings` can move the location — so it is read and
 * written through `CurrencyState` rather than captured.
 */
import type { Currency, FxRate, TokenPrices } from "@archymedes/core/money";
import { fetchDailyFxRate, startFxRateLookup, type FxLookupFailure } from "../platform/local-currency";
import type { ParsedArgs } from "../cli/args";
import { style } from "../cli/output";

type Environment = Record<string, string | undefined>;

/** The parts of the session's currency that change after startup. */
export type CurrencyState = {
  display: Currency;
  localCurrencyWarning: string | null;
};

/**
 * Display currency: explicit flags/configuration, then a coarse locale country, then the
 * provider's own currency. Accounting remains in the provider currency with the dated rate
 * attached to every converted report.
 *
 * Returns an exit code when the session cannot start (a budget with no usable rate), and
 * `undefined` otherwise. `onLateRate` runs when a background lookup lands after startup.
 */
export async function settleDisplayCurrency(options: {
  args: ParsedArgs;
  environment: Environment;
  prices: TokenPrices | undefined;
  rates: FxRate[];
  state: CurrencyState;
  onLateRate: () => void;
}): Promise<number | undefined> {
  const { args, environment, prices, rates, state } = options;
  if (prices && state.display !== prices.currency) {
    const configured = rates.some((rate) => (rate.from === prices!.currency && rate.to === state.display) || (rate.to === prices!.currency && rate.from === state.display));
    const fxFailures: FxLookupFailure[] = [];
    let pendingRate: ReturnType<typeof fetchDailyFxRate> | null = null;
    if (!configured && environment.ARCHYMEDES_FX_OFFLINE !== "true") {
      // Startup never waits on the network for display currency: a fresh cached rate is used at
      // once; otherwise the lookup runs in the background and costs show in the provider currency
      // (or a stale cached rate) until it lands. A spending cap is the exception — it is stated in
      // the display currency, so with no rate at all it still waits, exactly as before.
      const lookup = await startFxRateLookup(prices.currency, state.display, { environment, onFailure: (failure) => fxFailures.push(failure) });
      if (lookup.immediate) rates.push(lookup.immediate);
      if (lookup.refresh && args.budget && !lookup.immediate) {
        const daily = await lookup.refresh;
        if (daily) rates.push(daily);
      } else if (lookup.refresh) {
        pendingRate = lookup.refresh;
      }
    }
    const convertible = rates.some((rate) => (rate.from === prices!.currency && rate.to === state.display) || (rate.to === prices!.currency && rate.from === state.display));
    if (pendingRate) {
      const providerCurrency = prices.currency;
      const target = state.display;
      void pendingRate.then((daily) => {
        if (!daily) {
          // Only visible if the banner has not been drawn yet; afterwards costs simply stay put.
          if (!convertible) state.localCurrencyWarning = `No current ${providerCurrency}→${target} rate was available${fxFailures.length ? ` (${fxFailures.map((failure) => `${failure.host}: ${failure.diagnosis.message}`).join(" ")})` : ""}; costs remain in ${providerCurrency}.`;
          return;
        }
        const stale = rates.findIndex((rate) => rate.from === daily.from && rate.to === daily.to);
        if (stale >= 0) rates.splice(stale, 1, daily);
        else rates.push(daily);
        if (!convertible && state.display === providerCurrency) state.display = target;
        options.onLateRate();
      });
    }
    if (!convertible && pendingRate) {
      state.display = prices.currency;
    } else if (!convertible) {
      const tried = fxFailures.map((failure) => `${failure.host}: ${failure.diagnosis.message}`).join(" ");
      if (args.budget) {
        process.stderr.write(`${style.red("Cannot enforce the approved budget.")} No ${prices.currency}→${state.display} exchange rate is available${tried ? ` — the automatic lookup failed (${tried})` : ""}.\n`);
        process.stderr.write(`  ${style.dim(`Continue offline with a manual rate: set ARCHYMEDES_FX_FROM / ARCHYMEDES_FX_TO / ARCHYMEDES_FX_RATE, or keep costs in the provider currency with --currency ${prices.currency}. Run archymedes --doctor to see exactly which endpoint is failing.`)}\n`);
        return 1;
      }
      state.localCurrencyWarning = `No current ${prices.currency}→${state.display} rate was available${tried ? ` (${tried})` : ""}; costs remain in ${prices.currency}.`;
      state.display = prices.currency;
    }
  }
  return undefined;
}
