import type { RoutingReceipt } from "@archymedes/core/providers/routing-receipt";
import { clip, heading, note, rule, type SectionStyle, type Tone } from "./sections";
import { UNICODE_GLYPHS } from "../text/glyphs";

/**
 * The hosted routing decision, shown after a turn that used the exchange.
 *
 * The exchange's pitch is "best completed outcome per dollar, not the cheapest token", and that is
 * a claim the user should be able to check. So this prints what was chosen, what else was weighed
 * and why each was passed over, the policy the choice was held to, and the estimate against the
 * actual charge. Pure and width-safe, like `task-view.ts` and `completion-card.ts`.
 *
 * The receipt never carries the prompt (`EXCHANGE_API.md`); nothing sensitive is rendered here.
 */

/** Micros (millionths of a currency unit) as a trimmed decimal, e.g. `USD 0.0098`. */
export function formatMicros(micros: number | undefined, currency = "USD"): string {
  if (micros === undefined || !Number.isFinite(micros)) return "—";
  const value = micros / 1_000_000;
  const text = value.toFixed(6).replace(/\.?0+$/, "");
  return `${currency} ${text === "" || text === "-" ? "0" : text}`;
}

function routeMark(chosen: boolean, eligible: boolean, glyphs = UNICODE_GLYPHS): string {
  if (chosen) return glyphs.check;
  return eligible ? glyphs.middot : glyphs.cross;
}

export function renderRoutingReceipt(receipt: RoutingReceipt, style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(24, style.width);
  const cell = { ...style, width };
  const middot = glyphs.middot;
  const currency = receipt.currency ?? "USD";

  const head = (text: string, level: 1 | 3, tone?: Tone) => heading(clip(text, width - 2, glyphs), level, cell, tone);
  const row = (text: string, tone?: Tone) => note(clip(text, width - 4, glyphs), cell, tone);

  const badge = receipt.outcomeScore !== undefined ? `outcome ${receipt.outcomeScore.toFixed(2)}` : "";
  const out: string[] = [head("routing", 1, "accent")];

  out.push(head("chosen", 3));
  out.push(row(receipt.chosen.provider ? `${receipt.chosen.provider}/${receipt.chosen.model}` : receipt.chosen.model));

  const policyBits: string[] = [];
  if (receipt.policyId) policyBits.push(`${receipt.policyId}${receipt.policyVersion !== undefined ? ` v${receipt.policyVersion}` : ""}`);
  if (receipt.policy.dataPolicy) policyBits.push(receipt.policy.dataPolicy);
  if (receipt.policy.region) policyBits.push(`region ${receipt.policy.region}`);
  if (receipt.policy.qualityFloor !== undefined) policyBits.push(`floor ${receipt.policy.qualityFloor.toFixed(2)}`);
  if (receipt.policy.maximumMicros !== undefined) policyBits.push(`cap ${formatMicros(receipt.policy.maximumMicros, currency)}`);
  if (policyBits.length > 0) {
    out.push(head("policy", 3));
    out.push(row(policyBits.join(` ${middot} `)));
  }

  const costBits: string[] = [];
  if (receipt.estimatedMicros !== undefined) costBits.push(`est ${formatMicros(receipt.estimatedMicros, currency)}`);
  if (receipt.actualMicros !== undefined) costBits.push(`actual ${formatMicros(receipt.actualMicros, currency)}`);
  if (receipt.retries > 0) costBits.push(`${receipt.retries} retr${receipt.retries === 1 ? "y" : "ies"}`);
  if (receipt.latencyMs !== undefined) costBits.push(`${(receipt.latencyMs / 1000).toFixed(1)}s`);
  if (costBits.length > 0) {
    const overrun = receipt.estimatedMicros !== undefined && receipt.actualMicros !== undefined && receipt.actualMicros > receipt.estimatedMicros;
    out.push(head("cost", 3));
    out.push(row(costBits.join(` ${middot} `), overrun ? "warn" : "neutral"));
  }

  if (receipt.expectedTotalMicros !== undefined || receipt.predictedOutcomeScore !== undefined || receipt.costFactors) {
    out.push(head("forecast", 3));
    if (receipt.expectedTotalMicros !== undefined) out.push(row(`expected task cost ${formatMicros(receipt.expectedTotalMicros, currency)}`));
    if (receipt.predictedOutcomeScore !== undefined) out.push(row(`predicted quality ${receipt.predictedOutcomeScore.toFixed(2)}`));
    for (const [key, label] of [["retryMicros", "retries"], ["contextTransferMicros", "context transfer"], ["cacheSavingMicros", "cache savings"], ["verificationMicros", "verification"], ["nonModelMicros", "other work"]] as const) {
      const amount = receipt.costFactors?.[key];
      if (amount !== undefined && amount > 0) out.push(row(`${label} ${formatMicros(amount, currency)}`));
    }
  }

  if (receipt.attempts?.length) {
    out.push(head("attempts", 3));
    for (const [index, attempt] of receipt.attempts.entries()) {
      out.push(row(`${index + 1}. ${attempt.provider ? `${attempt.provider}/` : ""}${attempt.model} ${middot} ${attempt.outcome}${attempt.latencyMs !== undefined ? ` ${middot} ${(attempt.latencyMs / 1000).toFixed(1)}s` : ""}`, attempt.outcome === "succeeded" ? "good" : "warn"));
    }
  }

  if (receipt.considered.length > 0) {
    out.push(head("considered", 3));
    const chosenKey = `${receipt.chosen.provider ?? ""}/${receipt.chosen.model}`;
    for (const route of receipt.considered.slice(0, 6)) {
      const name = route.provider ? `${route.provider}/${route.model}` : route.model;
      const chosen = `${route.provider ?? ""}/${route.model}` === chosenKey || (!receipt.chosen.provider && route.model === receipt.chosen.model);
      const score = route.score !== undefined ? `score ${route.score.toFixed(2)}` : "";
      const est = route.estimatedMicros !== undefined ? formatMicros(route.estimatedMicros, currency) : "";
      const meta = [score, est].filter(Boolean).join(" ");
      out.push(row(
        `${routeMark(chosen, route.eligible, glyphs)} ${name}${meta ? `  ${meta}` : ""}${route.reason ? `  ${middot} ${route.reason}` : ""}`,
        chosen ? "good" : route.eligible ? "neutral" : "warn",
      ));
    }
    if (receipt.considered.length > 6) out.push(row(`${glyphs.ellipsis} ${receipt.considered.length - 6} more routes`));
  }

  return badge ? `${out.join("\n")}\n${rule(cell, { label: badge })}` : out.join("\n");
}

/** Currency buckets keep a mixed-currency session from presenting a fictitious total. */
export function renderRoutingSummary(receipts: readonly RoutingReceipt[], style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const cell = { ...style, width: Math.max(24, style.width) };
  const row = (text: string) => note(clip(text, cell.width - 4, glyphs), cell);
  const buckets = new Map<string, { actual: number; estimated: number; settled: number; estimates: number }>();
  let switches = 0;
  let retries = 0;
  for (const [index, receipt] of receipts.entries()) {
    const currency = receipt.currency ?? "USD";
    const bucket = buckets.get(currency) ?? { actual: 0, estimated: 0, settled: 0, estimates: 0 };
    if (receipt.actualMicros !== undefined) { bucket.actual += receipt.actualMicros; bucket.settled++; }
    if (receipt.estimatedMicros !== undefined) { bucket.estimated += receipt.estimatedMicros; bucket.estimates++; }
    buckets.set(currency, bucket);
    retries += receipt.retries;
    const previous = receipts[index - 1];
    if (previous && (previous.chosen.provider !== receipt.chosen.provider || previous.chosen.model !== receipt.chosen.model)) switches++;
  }
  const out = [heading("routing summary", 1, cell, "accent"), row(`${receipts.length} calls · ${retries} retries · ${switches} route switches`)];
  for (const [currency, bucket] of buckets) {
    out.push(row(`actual ${formatMicros(bucket.actual, currency)} (${bucket.settled} settled)`));
    if (bucket.estimates) out.push(row(`estimated ${formatMicros(bucket.estimated, currency)} (${bucket.estimates} estimates)`));
  }
  const missing = receipts.filter((receipt) => receipt.actualMicros === undefined).length;
  if (missing) out.push(row(`${missing} calls without settlement data`));
  return out.join("\n");
}
