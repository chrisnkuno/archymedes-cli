/**
 * What a turn that threw leaves behind: the recoverable-turn record, a named error with its next
 * step, and — once, before anything visible happened — a fallback to the configured provider.
 *
 * Moved out of `runTurn` unchanged; always resolves to `false`, the turn's result.
 */
import { fromUnits, formatMoney } from "@archymedes/core/money";
import { resolveProvider } from "@archymedes/core/providers/agent-matrix";
import { hostOf, providerBaseUrl } from "../platform/endpoints";
import { classifyNetworkError } from "../platform/network";
import { parseFallbackPreference } from "../session/fallback";
import { renderRecovery } from "../ui/navigation";
import type { TurnContext } from "./turn-runner";
import { activity, endStreamedLine, out, sectionStyle, spinner, statusBar, style, touchedFiles } from "./transcript";

export async function handleTurnFailure(error: unknown, request: string, context: TurnContext): Promise<false> {
  const { args, environment, interactive, headless, queuedInput, recoveryState, state, openClient, navContext } = context;
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
  const fallback = state.spec.id === "free" ? null : parseFallbackPreference(environment.ARCHYMEDES_FALLBACK_MODEL);
  const transient = diagnosis && ["timeout", "dns", "refused", "reset", "unreachable", "rate_limit", "server_error"].includes(diagnosis.kind);
  // Cross-provider retry is safe only before visible output, tool execution, or file changes.
  // A specific target is explicit consent; `ask` merely offers the choice and never spends.
  if (interactive && transient && !state.streamedAnswer && activity.toolCalls === 0 && touchedFiles.size === 0 && fallback?.kind === "target") {
    const attempt = resolveProvider(environment, { provider: fallback.provider, model: fallback.model });
    if (!("error" in attempt) && (attempt.spec.id !== state.spec.id || attempt.model !== state.resolvedModelId)) {
      const previous = state.agent;
      const carried = await previous.relinquish();
      state.model = attempt.provider;
      state.spec = attempt.spec;
      state.prices = attempt.prices;
      state.resolvedModelId = attempt.model;
      state.ledger.setPrices(state.prices);
      state.agent = await openClient(carried);
      queuedInput.unshift("/retry");
      out.write(style.yellow(`  falling back once to ${state.spec.label} ${state.resolvedModelId}; the unchanged request is queued for retry\n`));
    }
  } else if (interactive && transient && fallback?.kind === "ask") {
    out.write(style.dim("  fallback is set to ask — use /model to choose an alternate, then /retry\n"));
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
