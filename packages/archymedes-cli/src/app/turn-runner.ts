/**
 * One turn: the request goes to the agent, and the answer, its cost and what to do next come back
 * to the transcript.
 *
 * Moved out of `main()` unchanged. The checks before the model is contacted are in
 * `turn-preflight.ts`, and what a failed turn leaves behind is in `turn-failure.ts`.
 */
import type { Interface } from "node:readline/promises";
import { convertTo, formatMoney, type FxRate, type Money } from "@archymedes/core/money";
import type { Balance } from "@archymedes/core/cli/balance";
import { CACHE_CHURN_HINT, formatTokenFlow } from "@archymedes/core/cli/cost";
import { formatModelAllowance } from "@archymedes/core/providers/free-usage";
import type { ModelUsage } from "@archymedes/core/providers/model";
import { askModelForSuggestions, mergeModelSuggestions, type Suggestion as EngineSuggestion } from "@archymedes/core/cli/suggestions";
import { WANDER_LAB_FILES } from "@archymedes/core/wander";
import type { HeadlessEmitter } from "../headless";
import { paceBadge } from "../commands/pacing";
import { renderWanderResults, wanderArtifacts } from "../commands/wander";
import { renderCompletionCard } from "../render/completion-card";
import { renderMarkdown } from "../render/markdown";
import { renderRoutingReceipt } from "../render/routing-receipt";
import { rule } from "../render/sections";
import { formatStatusLine, Spinner } from "../render/tui";
import type { CliStateHistory } from "../session/state-history";
import type { detectColorDepth } from "../text/color-depth";
import { colorCode, rainbowHex } from "../theme/theme";
import { navSignals, renderAsks, renderSuggestions, type NavContext } from "../ui/navigation";
import type { OpenClient } from "./agent-factory";
import type { ParsedArgs } from "./args";
import type { BalanceTracking } from "./balance-tracking";
import { failureStatus } from "./session-hints";
import type { Environment, RecoverableTurn, SessionState } from "./session-state";
import type { StatusLine } from "./status-line";
import { showFreePrivacyNoticeOnce } from "./free-setup";
import { handleTurnFailure } from "./turn-failure";
import { saveSettings } from "../platform/settings";
import { runTurnPreflight } from "./turn-preflight";
import {
  SPINNER_START_DELAY_MS, activity, beginTranscriptTurn, contentWidth, endStreamedLine, glyphs, out, palette, renderUserTurn,
  screen, sectionStyle, setSpinner, spinner, statusBar, style, touchedFiles, turnLineDelta, verificationChecks,
} from "./transcript";

export type TurnContext = {
  args: ParsedArgs;
  environment: Environment;
  readline: Interface;
  interactive: boolean;
  ttyMode: boolean;
  depth: ReturnType<typeof detectColorDepth>;
  rates: FxRate[];
  approvedBudget: Money | undefined;
  headless: HeadlessEmitter | null;
  stateHistory: CliStateHistory;
  /** Lines the loop runs next as though typed; a provider fallback queues `/retry` here. */
  queuedInput: string[];
  /** Kept behind an object because a turn mutates it from an async closure. */
  recoveryState: { last: RecoverableTurn | null };
  state: SessionState;
  balance: Pick<BalanceTracking, "currentBalance" | "balanceWatch" | "sessionSpend" | "persistManualBalance" | "checkBalance" | "balanceHeader">;
  status: Pick<StatusLine, "showStatus" | "statusRoomFor">;
  openClient: OpenClient;
  navContext: () => NavContext;
  refreshProjectFiles: () => void;
};

/** Two usages as one, so a turn's cost line covers everything that turn actually spent. */
const addModelUsage = (left: ModelUsage, right: ModelUsage): ModelUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  totalTokens: left.totalTokens + right.totalTokens,
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  reasoningTokens: left.reasoningTokens + right.reasoningTokens,
});

export function createTurnRunner(context: TurnContext): (request: string) => Promise<boolean> {
  const { environment, interactive, ttyMode, depth, rates, headless, stateHistory, recoveryState, state, navContext, refreshProjectFiles } = context;
  const { persistManualBalance, checkBalance, balanceHeader, sessionSpend } = context.balance;
  const { showStatus, statusRoomFor } = context.status;

  /** Whether the extra model pass is on. A setting, read once, defaulting to off. */
  const suggestModel = (environment.ARCHYMEDES_SUGGEST_MODEL ?? "").trim().toLowerCase() === "on";

  /**
   * One small, tool-less call to the session's own model for a couple of extra suggestions.
   *
   * Never throws and never blocks the transcript on a failure: a suggestion is the least important
   * thing on screen, and a session must not see an error because the hint line could not think of
   * anything. The usage comes back with them so the caller can bill it to the turn it belongs to.
   */
  const modelSuggestions = async (
    request: string,
    summary: string,
  ): Promise<{ suggestions: EngineSuggestion[]; usage?: ModelUsage }> => {
    let usage: ModelUsage | undefined;
    const suggestions = await askModelForSuggestions(
      {
        complete: async ({ messages, maxOutputTokens }) => {
          const turn = await state.model.complete({
            messages: messages.map((message) => ({ role: message.role, content: message.content })),
            tools: [],
            maxOutputTokens,
            safetyIdentifier: state.agent.sessionId,
          });
          usage = turn.usage;
          return { content: turn.content };
        },
      },
      navSignals(navContext()),
      { lastRequest: request, lastSummary: summary },
    );
    return usage ? { suggestions, usage } : { suggestions };
  };

  return async (request: string): Promise<boolean> => {
      headless?.turnStart(request);
      state.sessionRequest ??= request; // the opening ask, kept for `/task`
      state.streamedAnswer = false;
      if (screen) {
        screen.parkInTranscript();
        // The bubble already carries its own "you" label on the box border — a rule printed above
        // it duplicated that label as a second, redundant divider (a leftover from before the two
        // terminal UIs were merged into one). One clearly delimited speaker marker, not two.
        out.write(`${renderUserTurn(request)}\n`);
      }

      if (!await runTurnPreflight(request, context)) return false;
      // Once ever, the first time free mode actually sends something: free endpoints may log it.
      if (state.spec.id === "free") {
        const acknowledged = await showFreePrivacyNoticeOnce({
          environment, saved: state.savedSettings, write: (text) => out.write(text), save: (settings) => saveSettings(settings, environment), style,
        });
        if (acknowledged) state.savedSettings = acknowledged;
      }
      const started = Date.now();
      beginTranscriptTurn();
      if (ttyMode) {
        activity.awaitingFirstDelta = true;
        // Free mode: every request costs $0 and spends the day's token allowance, so the status
        // line shows tokens (this turn's, plus the day's meter) where it would show money.
        const free = state.spec.id === "free";
        const fields = () => ({
          mode: state.mode,
          spinnerGlyph: spinner!.glyph,
          elapsedMs: Date.now() - started,
          toolCalls: activity.toolCalls,
          tokens: activity.tokens,
          cost: free ? "" : state.ledger.displayTotal ? formatMoney(state.ledger.displayTotal) : "cost unknown",
          ...(free && activity.allowance ? { allowance: { text: formatModelAllowance(activity.allowance), warning: Boolean(activity.allowance.warning) } } : {}),
          balance: balanceHeader().compact,
          phase: activity.phase,
          operation: activity.operation,
          // The agent's own plan, counted. Present only once it has one — an X-of-Y with nothing
          // behind it is worse than no counter at all.
          steps: activity.steps,
          badge: paceBadge(state.pace, glyphs),
        });
        // A pinned footer redraws its own fixed row and never needs the erase-above-cursor dance
        // `StatusBar` does — that class stays the renderer for every session without one.
        //
        // The activity line goes onto the input bar's top border, the same row the idle line uses, so
        // the box stays whole for the length of the turn instead of losing its lid the moment work
        // starts. It gets the border's inner width rather than the terminal's: `formatStatusLine`
        // drops segments to fit what it is given, and handing it the full width would have it fit a
        // row that the corners and title have already spent part of.
        // The rainbow theme's other animated surface: the thinking spinner cycles hue on its own
        // clock (a turn can run long after the identity art's rotation has stopped), the same
        // `rainbowHex` wheel the opening art sweeps, so the two feel like one running theme rather
        // than two different rainbow effects.
        const spinnerAccent = () => state.activeTheme?.name === "rainbow"
          ? colorCode(rainbowHex(Date.now() / 1500), depth)
          : palette.primary;
        const turnSpinner = new Spinner(() => screen?.pinned
          ? showStatus(formatStatusLine(fields(), statusRoomFor(screen.current.columns), depth, glyphs, spinnerAccent()))
          : statusBar.render(fields(), depth, glyphs, spinnerAccent()), 120, glyphs, SPINNER_START_DELAY_MS);
        setSpinner(turnSpinner);
        turnSpinner.start();
      }
      state.turnActive = true;
      state.currentTurnAbort = new AbortController();
      // Recorded only once the request is about to contact the model. A task rejected by safety,
      // balance or budget preflight was never attempted and must not become a misleading /retry.
      recoveryState.last = { request, status: "failed", toolCalls: 0, changedFiles: 0 };
      try {
        const spendBeforeTurn = sessionSpend() ?? 0;
        // Durable recall belongs to the shared agent, so CLI, desktop and jobs pay for each selected
        // fact once per thread. Wrapping here as well duplicated it on the first turn and left every
        // other front end without the incremental-deduplication policy.
        const result = await state.agent.send(request);
        recoveryState.last = {
          request,
          status: result.status,
          toolCalls: result.toolCallsExecuted,
          changedFiles: touchedFiles.size,
        };
        // `agent.send` has atomically saved the canonical snapshot and closed the turn's journal at
        // this point. Rebuild in the background so `/history` is instant after ordinary work; the
        // service coalesces this with a history command if the user asks before replay finishes.
        stateHistory.markDirty();
        void stateHistory.refresh();
        activity.awaitingFirstDelta = false;
        spinner?.stop();
        statusBar.clear();
        endStreamedLine();

        // On a non-completed status the runtime's summary explains the *stop*, not the work — so
        // printing it alone throws away everything the agent actually said. Observed on a real run
        // that wrote a working script: the answer vanished behind "needs verification". But the
        // summary for `needs_verification` specifically already embeds that same text ("The agent
        // reported: ..."), and a streamed answer is already on screen either way — printing it raw
        // *as well* in either case put the same paragraph on screen two or three times over.
        const spoken = [...result.messages].reverse().find(
          (message) => message.role === "assistant" && !("toolCalls" in message) && message.content.trim(),
        );
        const spokenText = spoken?.content.trim();
        // A provider that cannot stream reaches here with the whole answer at once. It gets the same
        // markdown treatment the streamed path gives it, so the two are indistinguishable on screen.
        const asMarkdown = (text: string) => renderMarkdown(text, { width: contentWidth(), depth, palette });
        // A provider that never streamed never printed renderEvent's assistant-section divider
        // branch owns — this is the one other place a reply begins, so it owns the header here.
        if (!state.streamedAnswer) {
          const label = activity.toolCalls > 0 || touchedFiles.size > 0 ? "summary" : "Archymedes";
          out.write(`\n${rule(sectionStyle(), { label, tone: "accent" })}\n`);
        }
        if (result.status !== "completed" && spokenText && !state.streamedAnswer && !result.summary.includes(spokenText)) {
          out.write(`\n${asMarkdown(spokenText)}\n`);
        }
        // When the answer streamed, it is already on screen — reprinting it verbatim is noise.
        if (!(result.status === "completed" && state.streamedAnswer)) {
          out.write(`\n${result.status === "completed" ? asMarkdown(result.summary) : style.yellow(result.summary)}\n`);
        }

        // A finished lab grades every claim it kept, and the grades are the finding. Read from the
        // structured file the lab writes rather than from its prose, and shown only when the run that
        // just ended was a wander — the file lingers in the project afterwards, and reprinting last
        // week's chart under an unrelated turn would be a lie about what just happened.
        if (state.wanderRunning) {
          state.wanderRunning = false;
          const graded = await state.agent.readFile(WANDER_LAB_FILES.results).catch(() => null);
          const chart = graded ? renderWanderResults(graded.content, sectionStyle(), contentWidth()) : null;
          if (chart) out.write(`${chart}\n`);
          const landed = (await Promise.all(wanderArtifacts().map(async (file) => (await state.agent.readFile(file, { limit: 1 }).catch(() => null)) ? file : null))).filter(Boolean);
          if (landed.length > 0) out.write(style.dim(`  lab files: ${landed.join(", ")}\n`));
        }

        // Before the turn is formatted: the ledger shows a free turn as tokens once it has a meter.
        if (state.spec.id === "free" && activity.allowance) state.ledger.recordAllowance(activity.allowance);
        const turn = state.ledger.record({
          usage: result.usage,
          iterations: result.iterations,
          toolCalls: result.toolCallsExecuted,
          elapsedMs: Date.now() - started,
        });
        // Skipped for a pure question-and-answer turn: with nothing changed, nothing verified and
        // no tool run, the card is five lines of "no" and the closing rule already carries the cost.
        const turnDidWork = touchedFiles.size > 0 || verificationChecks.size > 0 || result.toolCallsExecuted > 0;
        if (turnDidWork) {
          out.write(`${renderCompletionCard({
            status: result.status,
            files: [...touchedFiles].sort(),
            lineDelta: turnLineDelta.added > 0 || turnLineDelta.removed > 0 ? { ...turnLineDelta } : undefined,
            checks: [...verificationChecks].map(([kind, passed]) => ({ kind, passed })),
            toolCalls: result.toolCallsExecuted,
            iterations: result.iterations,
            elapsed: `${(turn.elapsedMs / 1_000).toFixed(1)}s`,
            cost: state.spec.id === "free" ? formatTokenFlow(turn.usage) : turn.cost ? formatMoney(convertTo(turn.cost, state.display, rates) ?? turn.cost) : "cost unknown",
          }, sectionStyle())}\n`);
        }
        // The hosted exchange returns one routing decision per model call. Keep them for `/route` and
        // show the turn's final one right under the card — the choice this answer was actually run on.
        if (result.routingReceipts && result.routingReceipts.length > 0) {
          out.write(`${renderRoutingReceipt(result.routingReceipts[result.routingReceipts.length - 1], sectionStyle())}\n`);
        }
        if (state.manualBalance !== undefined) {
          const turnSpend = Math.max(0, (sessionSpend() ?? spendBeforeTurn) - spendBeforeTurn);
          if (turnSpend > 0) {
            const remaining: Balance = { amount: Math.max(0, state.manualBalance.amount - turnSpend), currency: state.manualBalance.currency, asOf: Date.now() };
            await persistManualBalance(remaining).catch((error: unknown) => {
              state.manualBalance = remaining;
              out.write(style.yellow(`  Balance was updated for this session but could not be saved: ${error instanceof Error ? error.message : String(error)}\n`));
            });
          }
        }
        // The turn's own closing rule. A transcript without one is a single column in which the end
        // of an answer and the start of the next question look identical.
        out.write(`${rule(sectionStyle(), {
          label: result.status,
          tone: result.status === "completed" ? "good" : "warn",
          trailing: state.ledger.formatTurn(turn),
        })}\n`);
        const warning = state.ledger.budgetWarning();
        if (warning) out.write(`  ${style.yellow(warning)}\n`);
        await checkBalance();
        /**
         * The cache failure, said out loud, once.
         *
         * A defeated prompt cache is the most expensive thing that can go wrong in a long session —
         * a cached input token bills at about a tenth of a fresh one — and it is *silent*: the
         * session keeps working, the answers stay good, and the only symptom is the bill. Nobody
         * types `/cost` when nothing looks wrong, which is exactly when this is happening.
         *
         * Once per session, because it is a property of how the session is built rather than of this
         * turn: repeating it every turn would be repeating the same sentence about the same cause.
         */
        if (!state.cacheChurnReported && state.ledger.cacheHealth.churning) {
          state.cacheChurnReported = true;
          out.write(`  ${style.yellow(CACHE_CHURN_HINT)}\n`);
        }
        // A turn ending is the one moment a person is deciding what to do next, so this is where the
        // suggestions go: what the situation calls for, with the reason attached, plus — only when
        // the situation was quiet enough to leave room — one thing about Archymedes worth knowing.
        // Suppressed once they have used it: a hint you have taken is not a hint.
        state.lastFailure = result.status === "completed" ? null : { status: failureStatus(result.status), message: result.summary };
        // The optional model pass, off unless someone turned it on. Its cost is folded into *this*
        // turn's usage rather than recorded as a turn of its own: it is part of what answering this
        // request cost, and a phantom turn in `/cost` would misreport both the count and the shape of
        // the session's spend. It can only ever propose things to ask for, never actions to run.
        const asks: { suggestions: EngineSuggestion[]; usage?: ModelUsage } =
          suggestModel ? await modelSuggestions(request, result.summary) : { suggestions: [] };
        if (asks.usage) result.usage = addModelUsage(result.usage, asks.usage);
        const next = renderSuggestions(navContext(), sectionStyle(), { limit: 2, hints: true });
        if (next && interactive) out.write(`${next}\n`);
        if (asks.suggestions.length > 0 && interactive) {
          const rendered = renderAsks(mergeModelSuggestions([], asks.suggestions, { maxModel: 2 }), sectionStyle());
          if (rendered) out.write(`${rendered}\n`);
        }
        state.lastTurnStatus = result.status;
        headless?.turnEnd({
          status: result.status,
          summary: result.summary,
          iterations: result.iterations,
          toolCalls: result.toolCallsExecuted,
          usage: result.usage,
          cost: state.ledger.displayTotal ? formatMoney(state.ledger.displayTotal) : null,
          elapsedMs: Date.now() - started,
        });
        refreshProjectFiles(); // a turn can create files, and the next mention should complete them
      } catch (error) {
        return await handleTurnFailure(error, request, context);
      } finally {
        state.turnActive = false;
        state.currentTurnAbort = undefined;
        state.lastTurnEndedAt = Date.now();
      }
      return true;

  };
}
