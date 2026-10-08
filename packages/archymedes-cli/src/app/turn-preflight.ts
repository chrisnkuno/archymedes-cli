/**
 * Everything a turn checks before the model is contacted: the pace's cooldown, task safety, the
 * approved cap, and the estimate against the tracked balance and the pace.
 *
 * Moved out of `runTurn` unchanged. Returns `false` when the turn must not run — each refusal has
 * already said why — and `true` when it may.
 */
import { assessTaskSafety } from "@archymedes/core/cli/safety";
import { convertTo, priceUsage, toUnits, type Money } from "@archymedes/core/money";
import { assessTaskBalance } from "../commands/balance";
import { exceedsPace, paceBadge, remainingCooldown } from "../commands/pacing";
import { CountdownTimer, formatCountdown, progressBar, SpringAnimator } from "../render/tui";
import { confirmSensitiveTask } from "./prompts";
import type { TurnContext } from "./turn-runner";
import { forgetToolLines, glyphs, out, renderDepth, statusBar, style, toolLines } from "./transcript";

export async function runTurnPreflight(request: string, context: TurnContext): Promise<boolean> {
  const { args, readline, interactive, approvedBudget, rates, state } = context;
  const { currentBalance, balanceWatch, sessionSpend } = context.balance;
  // The pace's quiet time, spent before anything is sent. A pause after the *previous* turn is
  // where a person notices the agent misunderstood them; a pause after this one would be too late.
  const cooldown = remainingCooldown(state.pace, state.lastTurnEndedAt);
  if (cooldown > 0) {
    const totalCooldown = cooldown;
    const label = (remaining: number, fill: number) =>
      style.dim(`  ${paceBadge(state.pace, glyphs)} ${glyphs.middot} pausing [${progressBar(fill, 12, { depth: renderDepth, glyphs })}] ${formatCountdown(remaining)} before the next turn`);
    const handle = toolLines.append(label(cooldown, 1));
    // Two clocks, not one: CountdownTimer stays the second-by-second source the text reads from
    // (a bar's own physics has no business deciding what a person reads as "6s"), while the bar's
    // fill eases toward whatever fraction that implies on its own, faster cadence — so the shrink
    // reads as continuous motion between each second's change instead of only the number moving.
    let remainingNow = cooldown;
    const bar = new SpringAnimator(1, (fill) => toolLines.update(handle, label(remainingNow, fill)), { intervalMs: 60 });
    await new Promise<void>((resolve) => {
      new CountdownTimer(cooldown, (remaining) => {
        remainingNow = remaining;
        bar.retarget(Math.max(0, Math.min(1, remaining / totalCooldown)));
      }, () => {
        remainingNow = 0;
        bar.snapTo(0);
        forgetToolLines();
        resolve();
      }).start();
    });
  }
  const taskSafety = assessTaskSafety(request);
  if (state.mode !== "plan" && !await confirmSensitiveTask(readline, interactive, taskSafety, args.allowSensitive)) {
    out.write(style.yellow("  Task cancelled before the model was contacted.\n"));
    return false;
  }
  if (state.ledger.exhausted) {
    out.write(`${style.red("Budget spent.")} ${state.ledger.budgetWarning()}\n`);
    return false;
  }
  if (approvedBudget && state.prices) {
    const spent = state.ledger.displayTotal?.micros ?? 0;
    const remainingDisplay: Money = { currency: approvedBudget.currency, micros: Math.max(0, approvedBudget.micros - spent) };
    const remainingProvider = convertTo(remainingDisplay, state.prices.currency, rates);
    if (!remainingProvider) {
      out.write(`${style.red("Cannot continue safely — the approved cap cannot be converted to the provider currency.")}\n`);
      return false;
    }
    state.agent.setModelSpendLimit(remainingProvider.micros);
  }
  try {
    const prediction = await state.agent.estimate(request);
    out.write(style.dim(`  ${state.ledger.formatPrediction(prediction)}\n`));
    const trackedBalance = currentBalance();
    if (trackedBalance && state.prices) {
      const alert = balanceWatch.observe(trackedBalance, {
        sessionSpend: sessionSpend(),
        sessionTurns: state.ledger.history.length,
      });
      if (alert) for (const line of alert.lines) out.write(`  ${style.yellow(line)}\n`);
      const low = convertTo(priceUsage({ inputTokens: prediction.inputTokensLow, outputTokens: prediction.outputTokensLow }, state.prices), trackedBalance.currency, rates);
      const high = convertTo(priceUsage({ inputTokens: prediction.inputTokensHigh, outputTokens: prediction.outputTokensHigh }, state.prices), trackedBalance.currency, rates);
      const gate = low && high ? assessTaskBalance(trackedBalance, {
        low: toUnits(low),
        high: toUnits(high),
      }) : undefined;
      if (gate) {
        for (const line of gate.lines) out.write(`  ${gate.blocked ? style.red(line) : style.yellow(line)}\n`);
        if (gate.blocked) return false;
        if (interactive) {
          statusBar.clear();
          const answer = (await readline.question(`  ${style.yellow("?")} Continue with this balance? ${style.dim("[y/N]: ")}`)).trim().toLowerCase();
          if (answer !== "y" && answer !== "yes") {
            out.write(style.dim("  skipped — nothing was sent to the model\n"));
            return false;
          }
        }
      }
    }
    // The pace asks about a turn that looks expensive *before* it starts, which is the only
    // moment the answer is still cheap. Skipped without a terminal: there is nobody to ask, and a
    // pace is a preference, not a guard that should turn into a refusal in automation.
    if (interactive && exceedsPace(state.pace, prediction)) {
      statusBar.clear();
      const answer = (await readline.question(
        `  ${style.yellow(paceBadge(state.pace, glyphs))} this turn looks large. Run it? ${style.dim("[Y/n]: ")}`,
      )).trim().toLowerCase();
      if (answer !== "" && answer !== "y" && answer !== "yes") {
        out.write(style.dim("  skipped — nothing was sent to the model\n"));
        return false;
      }
    }
  } catch (error) {
    out.write(style.yellow(`  Could not estimate this turn: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  return true;
}
