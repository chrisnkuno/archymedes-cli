#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runAcpServer } from "./acp-server";
import { parseArgs, type ParsedArgs } from "./app/args";
import { findRecentSession, resumeOfferLine, resumePreference, type RecentSession } from "./app/resume-offer";
import { relativeTime } from "./commands/chat-history";
import { listSessions, loadSession } from "@archymedes/core/cli/session";
import { resolveSessionProvider } from "./app/session-provider";
import { parseFindCommand } from "./commands/find";
import { configureRendering, glyphs, out, renderEvent, renderUserTurn, screen, sessionStream, style } from "./app/transcript";
import { CommandUsage, type NavContext } from "./ui/navigation";
import { ArchymedesSessionDaemon, type DaemonNotification } from "@archymedes/core/cli/daemon";
import { type ProviderId } from "@archymedes/core/providers/agent-matrix";
import { fromUnits, formatMoney } from "@archymedes/core/money";
import { LocalWorkspace, type ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import type { AgentRuntimeResult } from "@archymedes/core/agent-runtime";
import { CostLedger } from "@archymedes/core/cli/cost";
import { EXIT_CODES, HeadlessEmitter } from "./headless";
import { buildModelCatalog } from "./session/models";
import { PRICE_CATALOG } from "@archymedes/core/providers/price-catalog";
import { detectColorDepth } from "./text/color-depth";
import { WorkspaceFrame } from "./ui/workspace-frame";
import { layoutNotice, parseLayoutCommand, resolveLayout, wantsPinnedFooter } from "./ui/layout-choice";
import { setWorkspaceMenu, installShortcuts } from "./ui/shortcuts";
import { completeInput } from "./catalog/commands";
import { KeyBindingRegistry, parseBindingOverrides } from "./terminal/keybindings";
import { resolveCurrencyPreference } from "./platform/local-currency";
import { loadSettings, mergedEnvironment, saveSettings } from "./platform/settings";
import { runFreeModeSetup } from "./app/free-setup";
import { loadHistory, saveHistory } from "./session/history";
import { WorkspaceController } from "./session/tabs";
import { TabSink } from "./terminal/output";
import { createPasteStore, installBracketedPaste } from "./terminal/bracketed-paste";
import { DEFAULT_THEME_NAME, NO_COLOR_PALETTE, buildPalette, detectPreferredTheme, findBuiltinTheme } from "./theme/theme";
import { findTheme } from "./theme/theme-files";
import { codeStyleFromEnvironment, setCodeStyle } from "./render/syntax";
import { enqueueJob, jobLogPath, newJobId } from "@archymedes/core";
import { resolveControlLanguage, t } from "./platform/i18n";
import { resolveGlyphs } from "./text/glyphs";
import { loadMemories, type MemoryEntry } from "./commands/memory";
import { type PaceLevel } from "./commands/pacing";
import { CliStateHistory } from "./session/state-history";
import { type ReadlineInternals, confirmSpendingCap, createApprovalPrompt, hiddenQuestion, isReadlineExit, questionWithEscape } from "./app/prompts";
import { readFxRates } from "./app/providers";
import { runJobWorkerProcess, spawnJobWorker } from "./app/job-launch";
import { runInformationFlag, runMaintenanceFlag } from "./app/startup-commands";
import { applyCurrencyPreference as applyDisplayCurrencyPreference, settleDisplayCurrency, type CurrencyState } from "./app/display-currency";
import type { SessionState } from "./app/session-state";
import { createWorkspaceFactory } from "./app/workspaces";
import { createBalanceTracking } from "./app/balance-tracking";
import { createClientFactory } from "./app/agent-factory";
import { createTabSwitching, type TabPayload } from "./app/tab-switching";
import { createStatusLine } from "./app/status-line";
import { createFileEditing } from "./app/file-editing";
import { createLiveModelRefresh, readCachedLiveModels } from "./app/live-models";
import { createBackgroundJobs } from "./app/background-jobs";
import { createSessionHints } from "./app/session-hints";
import { createTurnRunner } from "./app/turn-runner";
import type { RecoverableTurn } from "./app/session-state";
import type { ReplContext } from "./app/repl-context";
import { dispatchSlashCommand } from "./app/repl-dispatch";
import { createSigintHandling } from "./app/interrupts";
import { resumeAtStartup, runOneShot } from "./app/session-start";
import { writeStartupBanner } from "./app/startup-banner";
import { createLayoutSwitch, installInputChrome } from "./app/input-chrome";
import { createSettingsFlow } from "./app/settings-flow";
import { runStartupUpdate } from "./app/startup-update";

/**
 * Archymedes CLI — the terminal front end.
 *
 * Everything that decides what the agent may do lives in `lib/archymedes-cli`; this file only reads
 * input, renders output, and asks the human when the agent needs permission. Keeping the boundary
 * there is what allows a second front end (an editor extension, an HTTP server in OpenCode's
 * shape) to be added later without re-litigating any of the safety behaviour.
 */

async function main(): Promise<number> {
  // A closed pipe (`archymedes --help | head`, `archymedes --providers | less -F`) is not an error. Without
  // this, the write throws EPIPE and the CLI dies with a stack trace the user never asked for.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });

  // Not a normal invocation — this is the detached process a job spawns for itself. Dispatched
  // ahead of `parseArgs` because its argument shape (a root and a job id, no flags) is nothing
  // like an interactive session's.
  if (process.argv[2] === "--archymedes-job-worker") {
    const [, , , root, jobId] = process.argv;
    if (!root || !jobId) {
      process.stderr.write("Internal: --archymedes-job-worker requires <root> <jobId>\n");
      return 1;
    }
    return runJobWorkerProcess(root, jobId);
  }

  const args = parseArgs(process.argv.slice(2));
  const processEnvironment = process.env as Record<string, string | undefined>;
  let savedSettings = await loadSettings(processEnvironment);
  const environment = mergedEnvironment(savedSettings, processEnvironment);
  const stateHistory = new CliStateHistory(args.root, environment);
  let language = resolveControlLanguage(args.language ?? environment.ARCHYMEDES_LANGUAGE ?? environment.LANG);
  // Before anything prints. `--help`, `--providers` and `--sessions` all return long before the
  // interactive path configures rendering, and every one of them draws marks and rules — a terminal
  // that cannot render them should get the ASCII forms from the very first line, not from the point
  // a session happens to start.
  const earlyDepth = detectColorDepth(environment, Boolean(process.stdout.isTTY));
  // Built-ins only at this point: the on-disk themes live under the project root, and `--help` and
  // friends must not pay for a directory scan they will never use the result of.
  configureRendering(
    earlyDepth,
    Boolean(process.stdout.isTTY),
    args.ascii ? resolveGlyphs({ ...environment, ARCHYMEDES_GLYPHS: "ascii" }) : resolveGlyphs(environment),
    buildPalette(
      findBuiltinTheme(args.theme ?? detectPreferredTheme(environment)) ?? findBuiltinTheme(DEFAULT_THEME_NAME)!,
      earlyDepth,
    ),
  );
  // VS Code colours and numbered code blocks unless the settings say otherwise.
  setCodeStyle(codeStyleFromEnvironment(environment));
  const informational = runInformationFlag({ args, environment, language, earlyDepth });
  if (informational !== undefined) return informational;

  // Before anything that could print: from here on stdout is a protocol channel, and one stray
  // human-readable byte on it is a parse error the client cannot recover from.
  if (args.acp) {
    return runAcpServer({
      input: process.stdin,
      write: (line) => process.stdout.write(line),
      environment, provider: args.provider, model: args.model,
      defaultRoot: args.root,
      mode: args.mode,
    });
  }

  const maintenance = await runMaintenanceFlag({ args, environment, processEnvironment, language, stateHistory, savedSettings });
  if (maintenance !== undefined) return maintenance;

  /**
   * Headless mode claims stdout for JSONL, and gives the human stream to stderr.
   *
   * Done by redirecting the process stream rather than by routing each of the hundred existing
   * `process.stdout.write` calls, because the guarantee has to hold for output this file does not
   * own: a warning from a dependency, a line added later by someone who has not read this comment.
   * One choke point makes "stdout is only ever JSONL" structural instead of a convention.
   */
  let writeRecord: ((line: string) => void) | null = null;
  if (args.json) {
    if (!args.prompt) {
      process.stderr.write("--json runs a single turn: pass the request, for example archymedes --json \"fix the failing tests\".\n");
      return EXIT_CODES.usage;
    }
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    writeRecord = (line) => { realStdoutWrite(line); };
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
      (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
    // Escape codes aimed at a terminal are noise in a log file, and the spinner would redraw over
    // the diagnostics it shares the stream with.
    environment.NO_COLOR = "1";
  }

  // Refuse before provider discovery, workspace construction, history loading and update checks.
  // There is nobody to answer the prompt, and making a pipe wait for interactive-only setup turns
  // a simple usage error into a several-second startup under load.
  if (!args.prompt && !process.stdin.isTTY) {
    process.stderr.write(`${style.red("No terminal attached.")} Pass a request as an argument to run a single turn: archymedes "your request".\n`);
    await stateHistory.close();
    return 1;
  }

  let resolved = await resolveSessionProvider(environment, args);
  // With nothing configured, `resolveProvider` has already fallen back to keyless free mode when
  // this build (FREE_GATEWAY_URL) or the environment (ARCHYMEDES_FREE_GATEWAY_URL) names a free
  // gateway. An error that reaches here without an explicit selection means neither exists. In a
  // real terminal that is not a dead end: a short guided setup gets a free OpenRouter key, saves
  // it, and carries on into the session (see `runFreeModeSetup`) — never the full settings menu.
  // A pipe or --json run has nobody to answer, so it keeps the message and the non-zero exit.
  if ("error" in resolved && !args.provider && !args.model && !args.json && process.stdin.isTTY && process.stdout.isTTY) {
    const setupReadline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Ctrl+C during setup ends the question rather than leaving it paused.
    setupReadline.on("SIGINT", () => setupReadline.close());
    let saved: Awaited<ReturnType<typeof runFreeModeSetup>>;
    try {
      saved = await runFreeModeSetup(savedSettings, {
        write: (text) => { process.stdout.write(text); },
        askSecret: (question) => questionWithEscape((signal) => hiddenQuestion(setupReadline, question, signal)),
        save: (settings) => saveSettings(settings, processEnvironment),
        style,
      });
    } finally {
      setupReadline.close();
    }
    if (saved) {
      savedSettings = saved;
      Object.assign(environment, mergedEnvironment(savedSettings, processEnvironment));
      resolved = await resolveSessionProvider(environment, args);
    } else {
      await stateHistory.close();
      return 1;
    }
  }
  if ("error" in resolved && !args.provider && !args.model) {
    process.stderr.write(`${style.red("Archymedes is not configured.")} Free mode is not available in this build: set ${style.cyan("ARCHYMEDES_FREE_GATEWAY_URL")} to a free gateway URL to run without a key.\n`);
    process.stderr.write(style.dim(`Or set ${style.cyan("OPENROUTER_API_KEY")} to a free key from https://openrouter.ai/keys (in a terminal, ${style.cyan("archymedes")} guides you through it), or run ${style.cyan("archymedes settings")} to add a provider key.\n`));
    await stateHistory.close();
    return args.json ? EXIT_CODES.usage : 1;
  }
  if (!("error" in resolved) && resolved.spec.id === "free" && !args.provider && environment.ARCHYMEDES_PROVIDER?.trim() !== "free" && !args.json) {
    out.write(style.dim("Running free models with no key. Add your own provider key any time with archymedes settings.\n"));
  }
  if ("error" in resolved) {
    process.stderr.write(`${style.red("Archymedes is not configured.")} ${resolved.error}\n`);
    process.stderr.write(`Run ${style.cyan("archymedes settings")} to save a key without exporting one.\n`);
    return args.json ? EXIT_CODES.usage : 1;
  }
  let { provider: model, spec, prices } = resolved;
  let resolvedModelId = resolved.model;

  // Display currency: see `settleDisplayCurrency`. Held in locals the rest of the session reads,
  // and reached through `currency` by the code that changes it.
  const preference = resolveCurrencyPreference({ currency: args.currency, country: args.country, environment, providerCurrency: prices?.currency ?? "USD" });
  let display = preference.currency;
  const rates = readFxRates(environment);
  let localCurrencyWarning: string | null = null;
  const currency: CurrencyState = {
    get display() { return display; }, set display(value) { display = value; },
    get localCurrencyWarning() { return localCurrencyWarning; }, set localCurrencyWarning(value) { localCurrencyWarning = value; },
  };
  const currencyFailure = await settleDisplayCurrency({
    args, environment, prices, rates, state: currency,
    onLateRate: () => {
      try {
        ledger.setDisplay(display, rates);
        for (const tab of tabs.all) tab.payload.ledger.setDisplay(display, rates);
      } catch {
        // Not constructed yet: they read `display` and `rates` when they are, so nothing is lost.
      }
    },
  });
  if (currencyFailure !== undefined) return currencyFailure;
  if (args.budget && !prices) {
    process.stderr.write(`${style.red("Cannot enforce the approved budget.")} This model has no configured price. Configure its rate or omit --budget.\n`);
    return 1;
  }

  /**
   * This session's mutable locals, as the extracted modules see them: getter/setter pairs, so a
   * module reads each one at the moment it needs it and its writes land in these same locals.
   */
  const state: SessionState = {
    get savedSettings() { return savedSettings; }, set savedSettings(value) { savedSettings = value; },
    get language() { return language; }, set language(value) { language = value; },
    get model() { return model; }, set model(value) { model = value; },
    get spec() { return spec; }, set spec(value) { spec = value; },
    get prices() { return prices; }, set prices(value) { prices = value; },
    get resolvedModelId() { return resolvedModelId; }, set resolvedModelId(value) { resolvedModelId = value; },
    get display() { return display; }, set display(value) { display = value; },
    get projectFiles() { return projectFiles; }, set projectFiles(value) { projectFiles = value; },
    get themeName() { return themeName; }, set themeName(value) { themeName = value; },
    get activeTheme() { return activeTheme; }, set activeTheme(value) { activeTheme = value; },
    get mode() { return mode; }, set mode(value) { mode = value; },
    get pace() { return pace; }, set pace(value) { pace = value; },
    get memories() { return memories; }, set memories(value) { memories = value; },
    get workspace() { return workspace; }, set workspace(value) { workspace = value; },
    get ledger() { return ledger; }, set ledger(value) { ledger = value; },
    get manualBalance() { return manualBalance; }, set manualBalance(value) { manualBalance = value; },
    get agent() { return agent; }, set agent(value) { agent = value; },
    get liveModels() { return liveModels; }, set liveModels(value) { liveModels = value; },
    get currentTurnAbort() { return currentTurnAbort; }, set currentTurnAbort(value) { currentTurnAbort = value; },
    get pendingReadAbort() { return pendingReadAbort; }, set pendingReadAbort(value) { pendingReadAbort = value; },
    get turnActive() { return turnActive; }, set turnActive(value) { turnActive = value; },
    get exitRequested() { return exitRequested; }, set exitRequested(value) { exitRequested = value; },
    get detachRequested() { return detachRequested; }, set detachRequested(value) { detachRequested = value; },
    get explainedTabs() { return explainedTabs; }, set explainedTabs(value) { explainedTabs = value; },
    get wanderRunning() { return wanderRunning; }, set wanderRunning(value) { wanderRunning = value; },
    get lastScanFindings() { return lastScanFindings; }, set lastScanFindings(value) { lastScanFindings = value; },
    get lastFailure() { return lastFailure; }, set lastFailure(value) { lastFailure = value; },
    get cacheChurnReported() { return cacheChurnReported; }, set cacheChurnReported(value) { cacheChurnReported = value; },
    get streamedAnswer() { return streamedAnswer; }, set streamedAnswer(value) { streamedAnswer = value; },
    get lastTurnStatus() { return lastTurnStatus; }, set lastTurnStatus(value) { lastTurnStatus = value; },
    get sessionRequest() { return sessionRequest; }, set sessionRequest(value) { sessionRequest = value; },
    get lastTurnEndedAt() { return lastTurnEndedAt; }, set lastTurnEndedAt(value) { lastTurnEndedAt = value; },
    get where() { return where; }, set where(_value) { /* fixed once the banner is drawn */ },
  };

  /** Kitty images placed by `/cat` this session, removed again by `/clear`. */
  const kittyImages: number[] = [];
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    // Reads the cached project listing below, so completion never blocks on a filesystem walk.
    // Built per keystroke rather than cached: the catalog depends on `environment`, which a
    // `/settings` edit mutates mid-session, and a stale list would keep offering a provider whose
    // key was just removed. It is a walk over a literal table, not IO.
    completer: (line: string) => completeInput(line, projectFiles, buildModelCatalog(environment, undefined, liveModels).choices.map((choice) => choice.model)),
    history: (await loadHistory(environment)).reverse(),
    historySize: 200,
    removeHistoryDuplicates: true,
  });
  // Runtime-only readline state — see `ReadlineInternals`: the typed surface leaves these out.
  const rl = readline as unknown as Interface & ReadlineInternals;
  // Warmed once the workspace exists and refreshed after each turn, since a turn can create files.
  let projectFiles: string[] = [];
  const refreshProjectFiles = () => {
    // Only the REPL completes anything, so a one-shot run should not pay for a project walk.
    if (!interactive) return;
    void workspace.glob("**/*").then((files) => { projectFiles = files; }).catch(() => undefined);
  };
  const interactive = Boolean(process.stdin.isTTY);

  // Feature keys are a convenience over the command table, so they are built from it and every one
  // of them submits the command it stands for. Conflicts are reported now rather than discovered
  // later as a key that quietly does nothing.
  const keys = new KeyBindingRegistry(parseBindingOverrides(environment.ARCHYMEDES_KEYS), environment);
  // Set when Alt+B fires mid-turn. `turnActive`/`agent` are declared further down this function,
  // but nothing can invoke this closure before then — a keypress only ever arrives once the loop
  // below is already running.
  let detachRequested = false;
  // Held as options rather than installed inline, because the workspace screen has to give the
  // keyboard back to a *fresh* installation when it closes: it takes stdin for itself while it is
  // open, and a listener installed before that is one the framework has since torn down.
  const shortcutOptions = {
    readline, input: process.stdin, output: process.stdout, registry: keys,
    canSuggest: () => !turnActive,
    onIntercept: (command: string) => {
      if (command !== "/detach" || !turnActive) return false;
      detachRequested = true;
      agent.cancel();
      return true;
    },
  };
  let uninstallShortcuts = interactive ? installShortcuts(shortcutOptions) : () => {};
  const pastes = createPasteStore();
  const uninstallPaste = interactive && process.stdout.isTTY ? installBracketedPaste({ readline, output: process.stdout, store: pastes }) : () => {};
  const installShortcutsAgain = (): void => {
    if (interactive) uninstallShortcuts = installShortcuts(shortcutOptions);
  };
  // The status bar and spinner draw over the current line and redraw in place — meaningless
  // (and corrupting) output when either end of the pipe is not a real terminal.
  const ttyMode = interactive && !args.json && Boolean(process.stdout.isTTY);
  const depth = detectColorDepth(environment, !args.json && Boolean(process.stdout.isTTY));
  const sessionGlyphs = args.ascii ? resolveGlyphs({ ...environment, ARCHYMEDES_GLYPHS: "ascii" }) : resolveGlyphs(environment);
  /**
   * The theme this session paints with, now including any the project or the user wrote.
   *
   * A name that matches nothing is reported rather than substituted silently: a theme that does not
   * exist is nearly always a typo, and quietly rendering in something else makes the typo invisible.
   */
  let themeName = args.theme ?? detectPreferredTheme(environment);
  let activeTheme = await findTheme(themeName, args.root, environment);
  if (!activeTheme && args.theme) {
    out.write(style.yellow(`  No theme named "${args.theme}" — using ${DEFAULT_THEME_NAME}. /theme list shows what there is.\n`));
  }
  if (!activeTheme) {
    activeTheme = await findTheme(DEFAULT_THEME_NAME, args.root, environment);
    themeName = DEFAULT_THEME_NAME;
  }
  const applyTheme = (theme: { name: string; tokens: Parameters<typeof buildPalette>[0]["tokens"] }): void => {
    themeName = theme.name;
    configureRendering(depth, !args.json && Boolean(process.stdout.isTTY), sessionGlyphs, buildPalette(theme as Parameters<typeof buildPalette>[0], depth));
  };
  configureRendering(depth, !args.json && Boolean(process.stdout.isTTY), sessionGlyphs,
    activeTheme ? buildPalette(activeTheme, depth) : NO_COLOR_PALETTE);
  let mode = args.mode;
  let bindFixedNavigation = () => {};
  let unbindFixedNavigation = () => {};
  /** The spending pace, changeable mid-session with `/slow`. */
  let pace: PaceLevel = args.pace;
  /**
   * What Archymedes has been asked to remember, read once at startup and re-read whenever `/memory`
   * changes it. Held in memory because it is consulted on every turn and edited rarely.
   */
  let memories: MemoryEntry[] = await loadMemories(args.root, environment);

  /**
   * Every return point tears down the same three things, in the same order — reassigned once
   * `unbindSigint` exists (below) rather than duplicated, so an exit path added later can't forget
   * one. A scroll region left set when the process exits is inherited by the user's own shell
   * afterward, which reads as the terminal being broken until they notice and reset it themselves.
   */
  let exitCleanly = () => { screen?.exit(); setWorkspaceMenu(undefined); unbindFixedNavigation(); uninstallShortcuts(); uninstallPaste(); readline.close(); abandonPrompt(); };

  /**
   * Ends the `await readline.question(...)` that the REPL is parked on when the session is closing.
   *
   * Closing the interface does not settle a question already in flight, so without this the loop
   * stays awaiting a line that can never arrive and the shutdown below it — the goodbye, and more
   * importantly `agent.dispose()` — never runs. That was survivable only while nothing outlived a
   * turn: node exited on its own once no handles were left. A managed application (`start_application`)
   * is exactly such a handle, so a Ctrl+C with a preview server running would otherwise hang the
   * CLI forever and leak the server with it.
   */
  let rejectPrompt: ((error: Error) => void) | undefined;
  const abandonPrompt = () => {
    // The message is what `isReadlineExit` recognises, so this reaches the same break as Ctrl+D.
    rejectPrompt?.(new Error("readline was closed"));
    rejectPrompt = undefined;
  };
  /** A prompt that loses to the session ending, rather than outliving it. */
  const askForInput = (label: string): Promise<string> =>
    Promise.race([
      readline.question(label),
      new Promise<never>((_resolve, reject) => { rejectPrompt = reject; }),
    ]).finally(() => { rejectPrompt = undefined; });

  const approvedBudget = args.budget ? fromUnits(args.budget, display) : undefined;
  if (approvedBudget && !await confirmSpendingCap(readline, interactive, formatMoney(approvedBudget))) {
    out.write(style.yellow("  Spending not approved — no sandbox or model was started.\n"));
    exitCleanly();
    return 0;
  }

  const createWorkspace = createWorkspaceFactory(args, environment);

  let workspace: ArchymedesWorkspace;
  {
    const started = args.estimateOnly
      ? { workspace: new LocalWorkspace(args.root) }
      : await createWorkspace({ backend: args.backend });
    if ("error" in started) {
      process.stderr.write(`${style.red(started.error)}\n`);
      exitCleanly();
      return 1;
    }
    workspace = started.workspace;
  }

  refreshProjectFiles();

  let ledger = new CostLedger({
    prices,
    display,
    rates,
    catalog: PRICE_CATALOG,
    ...(approvedBudget ? { budget: approvedBudget } : {}),
  });

  const { criticalBalance, balanceWatch, parseManualBalance, currentBalance, persistManualBalance, sessionSpend, balanceHeader, checkBalance, carryResumedSpend } =
    createBalanceTracking({ root: args.root, environment, processEnvironment, rates, state });
  let manualBalance = parseManualBalance(environment.ARCHYMEDES_ACCOUNT_BALANCE, environment.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY);

  // Read at ask-time by `createApprovalPrompt`, not captured once: it is replaced every turn (an
  // `AbortSignal` is single-use) but the prompt function itself is built once per agent and must
  // keep seeing whichever turn is currently running.
  let currentTurnAbort: AbortController | undefined;
  /**
   * A read-only command that is waiting on the network — currently only `/route plan`.
   *
   * These run outside a turn, so `turnActive` is false and Ctrl+C would otherwise fall through to
   * the prompt's line-clearing branch and leave the request running unattended. Holding the
   * controller here lets the same keystroke stop the wait without touching the session.
   */
  let pendingReadAbort: AbortController | undefined;
  const approvalPrompt = createApprovalPrompt(readline, interactive, () => currentTurnAbort?.signal);
  const handleDaemonNotification = (notification: DaemonNotification) => {
    // `turn_started`/`turn_finished`/`session_opened` exist for a client with no other way to know
    // a turn's outcome; this CLI already gets that from `client.send()`'s own return value, so only
    // the event stream needs forwarding here.
    if (notification.type !== "agent_event") return;
    const event = notification.event;
    if (event.type === "runtime" && event.event.type === "assistant_delta") streamedAnswer = true;
    headless?.agentEvent(event);
    renderEvent(event);
  };
  /** One coordinator owns every live agent this process creates; see `app/agent-factory.ts`. */
  const daemon = new ArchymedesSessionDaemon();
  const openClient = createClientFactory({ args, environment, daemon, approvalPrompt, onNotification: handleDaemonNotification, rates, approvedBudget, state });
  // Human rendering still runs in headless mode — its output is the stderr diagnostic stream —
  // so a person watching a piped run sees the same narration a caller's parser ignores.
  const headless = writeRecord ? new HeadlessEmitter(writeRecord) : null;
  let agent = await openClient();

  /** One workspace, several pieces of work: see `app/tab-switching.ts`. */
  const tabs = new WorkspaceController<TabPayload>();
  const { stashActiveTab, enterTab, switchTab, showTabs } = createTabSwitching(tabs, state);
  const firstSink = new TabSink(sessionStream, { live: true });
  tabs.adopt(path.basename(args.root) || "archymedes", {
    agent, ledger, mode, sink: firstSink,
    provider: model, spec, prices, modelId: resolvedModelId,
    backend: args.backend, workspace, ownsWorkspace: false,
  });
  out.route(firstSink);
  /** Whether this session has already explained that a background tab is paused rather than working. */
  let explainedTabs = false;

  const { idleStatusLine, terminalControls, screenCapabilities, promptFrame, promptBox, inlineBar, statusRoomFor, showStatus, showIdleStatus } = createStatusLine({
    state, tabs, balanceHeader, depth, interactive, ttyMode, readline,
    keyboard: {
      uninstallShortcuts: () => uninstallShortcuts(),
      installShortcuts: () => installShortcutsAgain(),
      bindFixedNavigation: () => bindFixedNavigation(),
    },
  });
  const { editFile } = createFileEditing({ state, screenCapabilities, terminalControls, autosave: () => environment.ARCHYMEDES_EDITOR_AUTOSAVE?.trim().toLowerCase() === "on" });

  /** Models the providers report beyond this build's own list; see `app/live-models.ts`. */
  let liveModels: Partial<Record<ProviderId, string[]>> = {};
  const refreshLiveModels = createLiveModelRefresh(environment, state);
  await readCachedLiveModels(environment, state);

  const { watched, startWatching, startBackgroundJob } = createBackgroundJobs({ root: args.root, backend: args.backend, tabs, state });

  if (args.estimateOnly) {
    if (!args.prompt) {
      process.stderr.write("Pass the task to estimate, for example: archymedes --estimate \"fix the failing tests\"\n");
      await agent.dispose();
      exitCleanly();
      return 1;
    }
    out.write(`${ledger.formatPrediction(await agent.estimate(args.prompt))}\n`);
    await agent.dispose();
    exitCleanly();
    return 0;
  }

  // Getting back to an earlier chat. `--resume` with no id in a terminal opens the picker (below,
  // once the session is ready to swap); otherwise a recent chat in this folder is offered, or with
  // ARCHYMEDES_RESUME=always simply continued. See `app/resume-offer.ts`.
  const canAsk = interactive && Boolean(process.stdout.isTTY) && !args.json && !args.prompt;
  const pickAtStart = Boolean(args.resumePick) && canAsk;
  let startArgs: ParsedArgs = pickAtStart ? { ...args, resume: null } : args;
  let resumeOffer: RecentSession | undefined;
  if (!args.resume && canAsk && resumePreference(environment) !== "never") {
    const recent = await findRecentSession({ stateHistory, listSessions: (limit) => listSessions(args.root, limit), owns: async (id) => (await loadSession(args.root, id).catch(() => null)) !== null });
    if (recent && resumePreference(environment) === "always") startArgs = { ...args, resume: recent.id };
    else resumeOffer = recent;
  }
  const resumeFailure = await resumeAtStartup({ args: startArgs, interactive, stateHistory, state, openClient, exitCleanly: () => exitCleanly(), carryResumedSpend });
  if (resumeFailure !== undefined) return resumeFailure;

  // Ctrl-C interrupts the turn rather than the process; see `app/interrupts.ts`.
  let turnActive = false;
  let exitRequested = false;
  const { bindSigint, unbindSigint } = createSigintHandling({ readline, state, exitCleanly: () => exitCleanly() });
  bindSigint();
  exitCleanly = () => { unbindSigint(); watched.stopAll(); screen?.exit(); setWorkspaceMenu(undefined); unbindFixedNavigation(); uninstallShortcuts(); uninstallPaste(); readline.close(); abandonPrompt(); };

  /** Set when the turn about to run is a wander lab, so its results chart is printed once, after it. */
  let wanderRunning = false;
  /** Which commands this session has reached for, so suggestions stop offering what you already use. */
  const usage = new CommandUsage();
  /** Findings the last `/scan` reported, so defender work can be offered when there is some. */
  let lastScanFindings: number | undefined;
  /**
   * How the last turn went wrong, if it did — kept apart from `lastTurnStatus`, which starts at
   * "failed" so that a process that dies before its first turn exits non-zero. Reading that for a
   * *suggestion* would open every session by offering a way out of a failure that never happened.
   */
  let lastFailure: { status: NavContext["lastStatus"]; message: string } | null = null;
  /** Said once per session: the cache hint describes how the session is built, not this turn. */
  let cacheChurnReported = false;
  const { navContext, writeHint } = createSessionHints({ state, watched, tabs, usage, interactive });

  let streamedAnswer = false;
  /** The last turn's terminal status, which headless mode turns into the process exit code. */
  let lastTurnStatus: AgentRuntimeResult["status"] = "failed";
  /** The first thing this session was asked to do — the top line of `/task`. */
  let sessionRequest: string | undefined;
  // Kept behind an object because runTurn mutates it from an async closure. TypeScript otherwise
  // narrows a separately-declared nullable variable to its initializer in the outer prompt loop.
  const recoveryState: { last: RecoverableTurn | null } = { last: null };
  /** When the last turn finished, for the pace's cooldown. */
  let lastTurnEndedAt: number | undefined;
  /**
   * Work a screen decided on, waiting for the terminal to be free.
   *
   * A full-screen surface cannot start a model turn under itself — the turn would print into a
   * frame that is about to be erased, and there would be nothing to interrupt it with. So the
   * triage screen returns decisions, they land here, and the loop picks them up exactly as though
   * they had been typed. Drained before the prompt is drawn, so the queued objective is the next
   * thing that runs rather than the thing after whatever the user types next.
   */
  const queuedInput: string[] = [];
  const runTurn = createTurnRunner({
    args, environment, readline, interactive, ttyMode, depth, rates, approvedBudget, headless, stateHistory, queuedInput, recoveryState, state,
    balance: { currentBalance, balanceWatch, sessionSpend, persistManualBalance, checkBalance, balanceHeader },
    status: { showStatus, statusRoomFor },
    openClient, navContext, refreshProjectFiles,
  });

  if (args.prompt) {
    return runOneShot({ args, interactive, stateHistory, state, openClient, exitCleanly: () => exitCleanly(), prompt: args.prompt, headless, runTurn });
  }

  const where = workspace.kind === "e2b" ? `sandbox ${workspace.label.split(":")[1]}` : path.basename(args.root);
  await writeStartupBanner({ args, environment, readline, ttyMode, interactive, state, preference, localCurrencyWarning, navContext });
  if (resumeOffer) out.write(`${style.dim(`  ${glyphs.arrowRight} ${resumeOfferLine(resumeOffer, glyphs, (time) => relativeTime(time))}`)}\n`);

  // The footer goes up after the banner, not before; see `app/input-chrome.ts`.
  const setLayout = createLayoutSwitch({ args, environment, state, tabs, pinFooter: wantsPinnedFooter(args.pin, environment), showIdleStatus });
  if (ttyMode) {
    // Always constructed, because the suggestion dropdown needs its geometry either way; only the
    // *holding* of the scroll region — the part that costs scrollback — is what `--pin` buys.
    setLayout(resolveLayout(args, environment) === "fixed");
    ({ bindFixedNavigation, unbindFixedNavigation } = installInputChrome({
      environment, state, readline, rl, keys,
      status: { showIdleStatus, idleStatusLine, inlineBar, promptBox },
    }));
  }

  /** Re-reads the display currency from settings; see `applyCurrencyPreference` in `app/display-currency.ts`. */
  const applyCurrencyPreference = (): Promise<void> => applyDisplayCurrencyPreference({
    args, environment, prices, rates, state: currency,
    onDisplayChanged: () => {
      ledger.setDisplay(display, rates);
      for (const tab of tabs.all) tab.payload.ledger.setDisplay(display, rates);
    },
  });

  /** The settings menu, and everything that has to happen once it closes; see `app/settings-flow.ts`. */
  const openSettings = createSettingsFlow({
    args, environment, processEnvironment, readline, interactive, rates, state, parseManualBalance, openClient, applyCurrencyPreference,
    // A theme picked in /settings repaints the session now rather than at the next start.
    applyAppearance: async (current) => {
      const wanted = args.theme ?? current.ARCHYMEDES_THEME?.trim();
      if (!wanted || wanted === themeName) return;
      const theme = await findTheme(wanted, args.root, current);
      if (theme) { state.activeTheme = theme as typeof state.activeTheme; applyTheme(theme); }
    },
  });

  // One update round, before the first prompt and never again in this session.
  await runStartupUpdate(environment, interactive, currentBalance);

  /** Everything a slash command handled by the loop may read and do; see `app/repl-context.ts`. */
  const replContext: ReplContext = {
    state, args, environment, processEnvironment, readline, rl, interactive, depth, keys, rates, approvedBudget,
    tabs, watched, stateHistory, queuedInput, kittyImages, recoveryState,
    openClient, createWorkspace, runTurn, openSettings, editFile, navContext, writeHint, screenCapabilities, terminalControls,
    refreshLiveModels, applyTheme, carryResumedSpend, checkBalance, currentBalance, persistManualBalance, criticalBalance, sessionSpend,
    startBackgroundJob, startWatching, stashActiveTab, enterTab, switchTab, showTabs, bindSigint, unbindSigint,
  };

  // `--resume` with no id: the picker, now that there is a session to swap. Esc keeps this one.
  const leaveAtStart = pickAtStart && (await dispatchSlashCommand("/resume", replContext)) === "break";
  /** Set until the first prompt is answered: an empty Enter then means "continue that chat". */
  let offerPending = resumeOffer !== undefined;

  for (;;) {
    if (leaveAtStart) break;
    showIdleStatus();
    screen?.positionInput();
    let rawInput: string;
    const queued = queuedInput.shift();
    if (queued !== undefined) {
      // Echoed, because work that starts without anyone typing it must still be visible as a
      // request in the transcript — otherwise the next answer has no question above it.
      out.write(`${renderUserTurn(queued)}\n`);
    }
    try {
      // With a pinned footer the prompt is the input bar's left border, so readline redraws it as
      // part of the prompt and the box keeps its side through every edit. Without one there is no
      // box to have a side of, and the old inline label is still the right thing — with the leading
      // blank line it has always had on a session with no screen of any kind to separate it from.
      const modeLabel = mode === "plan" ? t(language, "mode.plan") : mode === "auto" ? t(language, "mode.auto") : mode === "defender" ? t(language, "mode.defender") : "archymedes";
      const label = `${style.cyan(modeLabel)}${style.dim(` ${glyphs.caret} `)}`;
      const promptLabel = screen?.pinned
        ? promptFrame(idleStatusLine()).prefix
        : inlineBar()
          ? promptBox.draw(mode, where, idleStatusLine())
          : screen ? label : `\n${label}`;
      if (queued === undefined && screen instanceof WorkspaceFrame) queueMicrotask(() => showIdleStatus());
      rawInput = queued ?? await askForInput(promptLabel);
    } catch (error) {
      if (isReadlineExit(error) || exitRequested) break;
      throw error;
    }
    // Erased before anything else prints, and with the submitted line in hand so the count covers
    // however many rows it wrapped onto. Leaves the cursor exactly where the top border was, which
    // is where the "you" bubble for this message is about to go.
    promptBox.erase(rawInput);
    // Before parking, so the transcript region is whole again before anything is written into it.
    screen?.clearSuggestions();
    // A search keeps reading history across `/find` steps; anything else returns to live output.
    if (screen instanceof WorkspaceFrame && screen.browsing && !parseFindCommand(rawInput.trim())) screen.scroll({ kind: "live" });
    screen?.parkInTranscript();
    let input = pastes.expand(rawInput).trim();
    if (offerPending && queued === undefined) {
      // The offer lasts exactly one answer: Enter takes it, anything typed starts fresh.
      offerPending = false;
      if (!input && resumeOffer) input = `/resume ${resumeOffer.id}`;
    }
    // A lone "?" is never a request worth sending a model; it is someone asking how this works.
    if (input === "?") input = "/help";
    if (!input) continue;

    const layoutCommand = parseLayoutCommand(input, screen instanceof WorkspaceFrame ? "fixed" : "scrollback");
    if (layoutCommand) {
      if (!ttyMode) out.write("  Fixed layout requires an interactive terminal.\n");
      else if ("error" in layoutCommand) out.write(layoutCommand.error);
      else { setLayout(layoutCommand.layout === "fixed"); out.write(style.dim(layoutNotice(layoutCommand.layout))); }
      continue;
    }

    usage.record(input);

    // Every slash command, in the order the loop has always tried them; see `app/repl-dispatch.ts`.
    // Whatever a command hands back (a retried request, a lab prompt, a saved prompt) runs as a turn.
    const outcome = await dispatchSlashCommand(input, replContext);
    if (outcome === "break") break;
    if (outcome === "continue") continue;
    input = outcome.input;

    await runTurn(input);

    // Alt+B fired while that turn was running: it is already stopped at a safe checkpoint and its
    // session already saved (agent.send persists after every turn, cancelled or not). Hand it to a
    // detached worker to pick up from exactly there, then give this tab a clean slate — continuing
    // to type into the same in-memory agent would leave two writers on one session file.
    if (detachRequested) {
      detachRequested = false;
      const sessionId = agent.sessionId;
      await agent.relinquish();
      agent = await openClient();
      const id = newJobId();
      const job = await enqueueJob(args.root, { id, objective: `Continue: ${input}`, logPath: jobLogPath(args.root, id), sessionId, modelSelection: model.selection });
      await spawnJobWorker(args.root, job.id);
      out.write(`  ${style.cyan("sent to background")} — job ${job.id} continues it. /attach ${job.id} to watch.\n`);
    }
  }

  process.stdout.write(style.dim("  bye — this session stays saved and resumable ✦\n"));
  await agent.dispose();
  // A tab opened and left open (never closed, never made active again) never got its own explicit
  // dispose — this is the safety net for it, closing whatever the daemon still holds, sandboxes
  // included, rather than leaking them on exit. Idempotent: the active agent above is already gone
  // from the daemon's session map by the time this runs, so its own dispose is not repeated.
  await daemon.shutdown();
  await stateHistory.close();
  const promptHistory = ([...((readline as Interface & { history?: string[] }).history ?? [])]).reverse();
  await saveHistory(promptHistory, environment).catch(() => undefined);
  exitCleanly();
  return 0;
}

/**
 * True when this file is the program being run, rather than an import.
 *
 * `import.meta.main` is a Bun and Node ≥22 convenience that does not exist on the Node versions a
 * published CLI still has to support, so the argv comparison is the portable form — and this file
 * has to stay importable by tests either way.
 */
export function isEntryPoint(): boolean {
  if (typeof (import.meta as { main?: boolean }).main === "boolean") return (import.meta as { main: boolean }).main;
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    // Resolved through symlinks on purpose. npm installs a binary as a link in `.bin`, so argv[1]
    // is that link while `import.meta.url` is the real file — comparing them raw makes an installed
    // `archymedes` exit silently with status 0, doing nothing at all.
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}

export { main };
