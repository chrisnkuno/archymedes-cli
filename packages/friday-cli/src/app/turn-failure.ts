/**
 * What a turn that threw leaves behind: the recoverable-turn record, a named error with its next
 * step, and — once, before anything visible happened — a fallback to the configured provider.
 *
 * Moved out of `runTurn` unchanged; always resolves to `false`, the turn's result.
 */
import { fromUnits, formatMoney } from "@archymedes/core/money";
import { hostOf, providerBaseUrl } from "../platform/endpoints";
import { classifyNetworkError } from "../platform/network";
import { renderRecovery } from "../ui/navigation";
import type { TurnContext } from "./turn-runner";
import { activity, endStreamedLine, out, sectionStyle, spinner, statusBar, style, touchedFiles } from "./transcript";

export async function handleTurnFailure(error: unknown, request: string, context: TurnContext): Promise<false> {
  const { args, environment, interactive, headless, recoveryState, state, navContext } = context;
  if (recoveryState.last?.request === request) {
    recoveryState.last = {
      ...recoveryState.last,
      status: "failed",
      toolCalls: activity.toolCalls,
      changedFiles: touchedFiles.size,
    };
  }
  activity.awaitingFirstDelta = false;
  spinner?.stop();
  statusBar.clear();
  endStreamedLine();
  const message = error instanceof Error ? error.message : String(error);
  // The runtime enforces the cap by throwing, which on its own reaches the user as a bare
  // internal sentence: no amount, no cap, no way forward. Name it for what it is.
  if (/exceeds the reserved model budget/i.test(message) && args.budget) {
    out.write(`\n${style.yellow(`Stopped at the ${formatMoney(fromUnits(args.budget, state.display))} cap for this request.`)}\n`);
    out.write(style.dim(`  Raise it with --budget, or ask for something smaller.\n`));
    state.lastTurnStatus = "iteration_limit";
    state.lastFailure = { status: "iteration_limit", message };
    const recovery = renderRecovery(navContext(), sectionStyle());
    if (recovery && interactive) out.write(`${recovery}\n`);
    headless?.error(`Stopped at the approved cap for this request.`, { status: "iteration_limit" });
    return false;
  }
  // A raw transport error ("fetch failed", "getaddrinfo ENOTFOUND …") reads as "the internet
  // is broken", which is usually wrong — it is one endpoint failing. Name the host, the
  // failure class, and the next step; anything that is not a network fault prints as before.
  const diagnosis = classifyNetworkError(error, {
    host: hostOf(providerBaseUrl(environment, state.spec.id)),
    purpose: `the model API (${state.spec.label})`,
  });
  if (diagnosis) {
    out.write(`${style.red("error")} ${diagnosis.message}\n`);
    if (diagnosis.hint) out.write(`  ${style.dim(diagnosis.hint)}\n`);
  } else {
    out.write(`${style.red("error")} ${message}\n`);
  }
  // An error says what broke; this says what to do about it. The rules only speak when they
  // recognise the failure — an invented next step after a real error costs a detour to
  // discover it was a guess, which is worse than the silence it replaced.
  state.lastFailure = { status: "failed", message };
  const recovery = renderRecovery(navContext(), sectionStyle());
  if (recovery && interactive) out.write(`${recovery}\n`);
  state.lastTurnStatus = "failed";
  headless?.error(message, { status: "failed" });
  return false;
}
