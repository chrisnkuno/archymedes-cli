import type { RoutingPlan } from "@archymedes/core/providers/routing-plan";
import { clip, heading, note, rule, type SectionStyle, type Tone } from "./sections";
import { UNICODE_GLYPHS } from "../text/glyphs";
import { formatMicros } from "./routing-receipt";

/**
 * What the exchange *would* route the next turn to, shown before anything is spent.
 *
 * `/route` answers "what did that cost"; this answers "what would this cost, and on what". The
 * difference matters for how it reads: every figure here is a forecast, so the panel says so once,
 * at the top, rather than dressing estimates up in the same type as a settled charge.
 *
 * Two states are easy to render wrongly and are handled explicitly:
 *
 *  - No route available. An empty ranking is not a quiet success — it means the work cannot run at
 *    all right now, so it prints as a warning with the reasons underneath, never as an empty list.
 *  - Excluded routes. A provider whose credential is missing was never weighed, so it is kept out
 *    of the ranking and shown separately; folding it in would imply it lost on merit.
 *
 * Pure and width-safe, like `routing-receipt.ts`. No prompt text reaches this module.
 */
export function renderRoutingPlan(plan: RoutingPlan, style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(24, style.width);
  const cell = { ...style, width };
  const middot = glyphs.middot;
  const head = (text: string, level: 1 | 3, tone?: Tone) => heading(clip(text, width - 2, glyphs), level, cell, tone);
  const row = (text: string, tone?: Tone) => note(clip(text, width - 4, glyphs), cell, tone);

  const out: string[] = [head("routing plan", 1, "accent")];

  const policyBits: string[] = [];
  if (plan.policyId) policyBits.push(`${plan.policyId}${plan.policyVersion !== undefined ? ` v${plan.policyVersion}` : ""}`);
  policyBits.push("forecast only — nothing reserved, no model called");
  out.push(row(policyBits.join(` ${middot} `)));

  if (plan.ranked.length === 0) {
    // The user asked what would run. "Nothing can" is the answer, and it has to look like one.
    out.push(head("no route available", 3, "warn"));
    if (plan.excluded.length === 0) out.push(row("the exchange returned no eligible route and gave no reason", "warn"));
  } else {
    out.push(head("would use", 3));
    for (const [index, route] of plan.ranked.slice(0, 4).entries()) {
      const name = route.provider ? `${route.provider}/${route.model}` : route.model;
      const mark = index === 0 ? glyphs.check : route.eligible ? glyphs.middot : glyphs.cross;
      const tone = index === 0 ? "good" : route.eligible ? "neutral" : "warn";
      // Name, then figures, then reason — each on its own row. On a narrow terminal a wordy reason
      // would otherwise push the cost and quality past the clip, losing exactly what was asked for.
      out.push(row(`${mark} ${name}${route.fundingSource === "byok" ? `  ${middot} your key` : ""}`, tone));
      const bits: string[] = [];
      if (route.expectedTotalMicros !== undefined) bits.push(`~${formatMicros(route.expectedTotalMicros, plan.currency)} task`);
      else if (route.estimatedMicros !== undefined) bits.push(`~${formatMicros(route.estimatedMicros, plan.currency)} call`);
      if (route.completedQuality !== undefined) bits.push(`quality ${route.completedQuality.toFixed(2)}`);
      if (route.expectedLatencyMs !== undefined) bits.push(`${(route.expectedLatencyMs / 1000).toFixed(1)}s`);
      if (route.expectedAttempts !== undefined && route.expectedAttempts > 1.05) bits.push(`${route.expectedAttempts.toFixed(1)} attempts`);
      if (bits.length > 0) out.push(row(`  ${bits.join(` ${middot} `)}`, tone));
      if (route.reason) out.push(row(`  ${route.reason}`));
    }
    if (plan.ranked.length > 4) out.push(row(`${glyphs.ellipsis} ${plan.ranked.length - 4} more routes`));
  }

  if (plan.excluded.length > 0) {
    out.push(head("unavailable", 3));
    for (const route of plan.excluded.slice(0, 6)) {
      const name = route.provider ? `${route.provider}/${route.model}` : route.model;
      out.push(row(`${glyphs.cross} ${name}${route.reason ? `  ${middot} ${route.reason}` : ""}`, "warn"));
    }
    if (plan.excluded.length > 6) out.push(row(`${glyphs.ellipsis} ${plan.excluded.length - 6} more unavailable`));
  }

  const best = plan.ranked[0];
  if (best?.outcomePerDollar !== undefined && best.outcomePerDollar > 0) {
    return `${out.join("\n")}\n${rule(cell, { label: `${best.outcomePerDollar.toFixed(1)} predicted quality per ${plan.currency} unit` })}`;
  }
  return out.join("\n");
}
