/**
 * What an interactive session opens on: the identity art, one dim context line, the warnings that
 * ask for a decision, and — for someone about to type — the starters and the essentials.
 *
 * Moved out of `main()` unchanged.
 */
import path from "node:path";
import type { Interface } from "node:readline/promises";
import { PRICE_ENVIRONMENT_HINT } from "@archymedes/core/providers/agent-matrix";
import { paceBadge } from "../commands/pacing";
import type { resolveCurrencyPreference } from "../platform/local-currency";
import { ARCHYMEDES_CLI_VERSION } from "../platform/update";
import { writeIdentity } from "../render/identity";
import { renderReliabilityStatus } from "../render/reliability-status";
import { resolveLayout } from "../ui/layout-choice";
import { SIMPLE_BANNER_LINE, isSimpleMode, renderEssentials, renderStarters, type NavContext } from "../ui/navigation";
import type { ParsedArgs } from "./args";
import type { Environment, SessionState } from "./session-state";
import { glyphs, out, palette, sectionStyle, style } from "./transcript";

export async function writeStartupBanner(options: {
  args: ParsedArgs;
  environment: Environment;
  readline: Interface;
  ttyMode: boolean;
  interactive: boolean;
  state: Pick<SessionState, "spec" | "resolvedModelId" | "mode" | "display" | "pace" | "memories" | "prices" | "where">;
  preference: ReturnType<typeof resolveCurrencyPreference>;
  localCurrencyWarning: string | null;
  navContext: () => NavContext;
}): Promise<void> {
  const { args, environment, readline, ttyMode, interactive, state, preference, navContext } = options;
  const identityMotion = new AbortController();
  const stopIdentityMotion = () => identityMotion.abort();
  if (ttyMode) process.stdin.on("data", stopIdentityMotion);
  try {
    await writeIdentity({
      width: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      version: ARCHYMEDES_CLI_VERSION,
      workspace: state.where,
      model: `${state.spec.label} ${state.resolvedModelId}`,
      mode: state.mode,
      palette,
      glyphs,
    }, out, {
      enabled: ttyMode && resolveLayout(args, environment) !== "fixed" && !readline.line && environment.TERM !== "dumb" && environment.NO_COLOR === undefined && environment.ARCHYMEDES_NO_MOTION !== "1",
      signal: identityMotion.signal,
      size: () => ({ width: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }),
    });
  } finally {
    if (ttyMode) process.stdin.off("data", stopIdentityMotion);
  }
  // Simple mode (the default): one line that says how to use this, and nothing else to learn yet.
  // Spend caps, prices and starters all still exist — /settings turns ARCHYMEDES_SIMPLE off to see
  // them here again — but a first screen is for starting, not for reading.
  if (isSimpleMode(environment)) {
    if (options.localCurrencyWarning) out.write(`${style.yellow(`  ${options.localCurrencyWarning}`)}\n`);
    if (interactive && !args.prompt) out.write(`${style.dim(`  ${SIMPLE_BANNER_LINE.replace(/ · /g, ` ${glyphs.middot} `)}`)}\n`);
    return;
  }
  // One dim context line under the identity rather than a stack of them: the benchmark, the
  // currency costs are shown in, and any standing session modifiers (pace, remembered facts). The
  // yellow lines below are the ones that ask for a decision, so those keep their own rows.
  const context = [
    renderReliabilityStatus(999, glyphs.middot),
    `costs ${state.display}${preference.countryCode ? ` ${glyphs.middot} location ${preference.countryCode}` : ""} (${preference.source === "location" ? "auto-detected" : preference.source})`,
  ].filter(Boolean);
  if (state.pace !== "off") context.push(`${paceBadge(state.pace, glyphs)} ${glyphs.middot} /slow off to lift`);
  if (state.memories.length > 0) context.push(`${state.memories.length} remembered fact${state.memories.length === 1 ? "" : "s"} ${glyphs.middot} /memory`);
  out.write(`${style.dim(`  ${context.join(`  ${glyphs.middot}  `)}`)}\n`);
  if (options.localCurrencyWarning) out.write(`${style.yellow(`  ${options.localCurrencyWarning}`)}\n`);
  if (!args.budget) {
    out.write(`${style.yellow(`  No session spend cap set ${glyphs.middot} use --budget N to approve and enforce one.`)}\n`);
    // Named beside the cap it is not: someone reading that line is thinking about spending, and
    // this is the other half of the answer.
    if (state.pace === "off") out.write(style.dim(`  ${glyphs.middot} /slow paces spending without capping it\n`));
  }
  if (!state.prices) {
    out.write(`${style.yellow(`  No price configured for ${state.resolvedModelId} ${glyphs.middot} costs will show as unknown.`)}\n`);
    out.write(`${style.dim(`  Set ${PRICE_ENVIRONMENT_HINT}, or run archymedes --providers.`)}\n`);
  }
  // An empty prompt under a banner says the tool is ready without saying what it is ready for.
  // Only for a session someone is about to type into: a `--prompt` run already knows what it wants,
  // and a pipe has nobody to read them.
  if (interactive && !args.prompt) {
    const starters = renderStarters(navContext(), sectionStyle(), path.basename(args.root));
    if (starters) out.write(`\n${starters}\n`);
    // Under the starters, because "what could I ask" comes before "how do I take it back" — but
    // only just: the second question is the one that makes the first safe to answer.
    const essentials = renderEssentials(navContext(), sectionStyle());
    if (essentials) out.write(`${essentials}\n`);
  }
}
