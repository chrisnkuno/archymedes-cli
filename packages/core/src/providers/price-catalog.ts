import { definePrices, type PriceRecord } from "../pricing";

/**
 * The published rates this build knows, in the currency each provider actually quotes.
 *
 * Recorded in the provider's own currency and denominator rather than pre-converted, because a table
 * denominated in a currency nobody publishes is a table nobody can check against an invoice.
 * Conversion happens at display time, against a dated FX rate that travels with the quote.
 *
 * `effectiveFrom` is the earliest date this build can attest the rate applied — the date the entry
 * was verified against the provider's price page, not a claim about when the provider introduced it.
 * That is the conservative reading: it never causes a historical cost to be re-priced at a rate that
 * had not been confirmed yet.
 *
 * A model absent from here still runs. It reports "unpriced" rather than being quietly assigned a
 * neighbour's rate, because a confidently wrong cost is worse than an admitted unknown.
 */

const ANTHROPIC_VERIFIED = "2026-06-24";
const ANTHROPIC_SOURCE = "anthropic.com/pricing, recorded 2026-06-24";

/**
 * Anthropic list prices, USD per million tokens.
 *
 * Cached input is a tenth of the input rate throughout — the published cache-read multiplier — and
 * it is what makes a long agent session affordable. Recording it is the difference between a cost
 * report that shows the saving and one that overstates a cached session by roughly ten times.
 */
const ANTHROPIC: PriceRecord[] = [
  ...["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"].map((model) => tokens("anthropic", model, "USD", 5, 25, 0.5, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED)),
  tokens("anthropic", "claude-fable-5", "USD", 10, 50, 1, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED),
  tokens("anthropic", "claude-sonnet-4-6", "USD", 3, 15, 0.3, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED),
  tokens("anthropic", "claude-haiku-4-5", "USD", 1, 5, 0.1, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED),

  // Sonnet 5 is the reason this catalog is dated rather than constant. It runs on an introductory
  // rate that ends 2026-08-31; both rates are true, on different days, and a single hardcoded
  // number would be wrong on one side of that boundary with nothing to signal which side.
  { ...tokens("anthropic", "claude-sonnet-5", "USD", 2, 10, 0.2, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED), effectiveUntil: "2026-09-01", source: `${ANTHROPIC_SOURCE} (introductory rate through 2026-08-31)` },
  { ...tokens("anthropic", "claude-sonnet-5", "USD", 3, 15, 0.3, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED), effectiveFrom: "2026-09-01", source: `${ANTHROPIC_SOURCE} (standard rate from 2026-09-01)` },
];

/** Builds a text-token `PriceRecord` at the provider's own per-million rate. */
function tokens(provider: string, model: string, currency: string, input: number, output: number, cachedInput: number | undefined, source: string, effectiveFrom: string): PriceRecord {
  return {
    provider,
    model,
    modality: "text",
    currency,
    billingUnit: "tokens",
    per: 1_000_000,
    rates: { input, output, ...(cachedInput === undefined ? {} : { cachedInput }) },
    source,
    effectiveFrom,
  };
}

const OAI_COMPAT_SOURCE = "each provider's public pricing page — indicative defaults, recorded 2026-06-01";
const OAI_COMPAT_VERIFIED = "2026-06-01";

/**
 * Indicative USD list prices for the default model of each OpenAI-compatible provider.
 *
 * These are conservative reference points, not a maintained rate card: a model absent here (or a
 * `<PROVIDER>_MODEL` override) reports "unpriced" rather than borrowing a neighbour's number, and a
 * negotiated or changed rate is set through the price-override environment variables. xAI, Google
 * and DeepSeek publish a higher tier above a large input threshold, recorded as `largeContext`.
 */
const OAI_COMPAT_LABS: PriceRecord[] = [
  { ...tokens("google", "gemini-2.5-pro", "USD", 1.25, 10, 0.31, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED), largeContext: { aboveInputTokens: 200_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  tokens("google", "gemini-2.5-flash", "USD", 0.3, 2.5, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  { ...tokens("xai", "grok-4", "USD", 3, 15, 0.75, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED), largeContext: { aboveInputTokens: 200_000, inputMultiplier: 2, outputMultiplier: 2 } },
  tokens("xai", "grok-4-fast", "USD", 0.2, 0.5, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("deepseek", "deepseek-chat", "USD", 0.28, 0.42, 0.028, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("deepseek", "deepseek-reasoner", "USD", 0.28, 2.19, 0.028, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("mistral", "mistral-large-latest", "USD", 2, 6, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("mistral", "mistral-small-latest", "USD", 0.2, 0.6, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("groq", "llama-3.3-70b-versatile", "USD", 0.59, 0.79, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
];

/**
 * Non-model meters.
 *
 * A task's cost is not only its tokens. Search, transcription and sandbox time are billed by other
 * providers on other denominators, and leaving them out does not make them free — it makes the
 * reported total quietly lower than the invoice, which is the one direction a cost report must
 * never be wrong in.
 */
const SERVICES: PriceRecord[] = [
  {
    provider: "exa",
    model: "search",
    modality: "search",
    currency: "USD",
    billingUnit: "requests",
    per: 1_000,
    // Two meters on one call: the search itself, and each page whose contents are returned. A
    // ten-result search with highlights is therefore ~$0.017, not the ~$0.007 the request price
    // alone suggests — the contents component is the larger half at typical result counts.
    rates: { request: 7, contents: 1 },
    source: "exa.ai/pricing (API tab)",
    effectiveFrom: "2026-08-10",
  },
];

export const PRICE_CATALOG: readonly PriceRecord[] = definePrices([...ANTHROPIC, ...OAI_COMPAT_LABS, ...SERVICES]);

/**
 * Providers this build deliberately ships no rates for.
 *
 * OpenAI's catalog is not verified here — a wrong price is worse than an honest "unpriced" — and a
 * generic openai-compatible endpoint has no catalog at all. Both report costs as unknown until a
 * rate is configured through the price-override environment variables. Ollama is priced at zero in
 * `catalogPrices` rather than listed here, because local inference is metered by nobody.
 */
export const UNPRICED_PROVIDERS: readonly string[] = ["openai", "archymedes-cloud", "openai-compatible"];
