import type { RoutingReceipt } from "@archymedes/core/providers/routing-receipt";
import { clip, heading, note, rule, type SectionStyle, type Tone } from "./sections";
import { UNICODE_GLYPHS } from "./glyphs";

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

  if (receipt.considered.length > 0) {
    out.push(head("considered", 3));
    const chosenKey = `${receipt.chosen.provider ?? ""}/${receipt.chosen.model}`;
    for (const route of receipt.considered.slice(0, 6)) {
      const name = route.provider ? `${route.provider}/${route.model}` : route.model;
      const chosen = `${route.provider ?? ""}/${route.model}` === chosenKey || route.model === receipt.chosen.model;
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
