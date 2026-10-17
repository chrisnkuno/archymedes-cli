#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runAcpServer } from "./acp-server";
import { parseArgs } from "./app/args";
import { resolveSessionProvider } from "./app/session-provider";
import { configureRendering, out, renderEvent, sessionStream, style } from "./app/transcript";
import { CommandUsage, type NavContext } from "./ui/navigation";
import { ArchymedesSessionDaemon, type DaemonNotification } from "@archymedes/core/cli/daemon";
import { type ProviderId } from "@archymedes/core/providers/agent-matrix";
import { fromUnits, formatMoney } from "@archymedes/core/money";
import { LocalWorkspace, type ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import type { AgentRuntimeResult } from "@archymedes/core/agent-runtime";
import { CostLedger } from "@archymedes/core/cli/cost";
import { EXIT_CODES, HeadlessEmitter } from "./headless";
import { PRICE_CATALOG } from "@archymedes/core/providers/price-catalog";
import { detectColorDepth } from "./text/color-depth";
import { escapeCodeTimeoutMs } from "./terminal/keybindings";
import { resolveCurrencyPreference } from "./platform/local-currency";
import { loadSettings, mergedEnvironment, saveSettings } from "./platform/settings";
import { runFreeModeSetup } from "./app/free-setup";
import { WorkspaceController } from "./session/tabs";
import { TabSink } from "./terminal/output";
import { WatchRegistry } from "./terminal/job-stream";
import { DEFAULT_THEME_NAME, NO_COLOR_PALETTE, buildPalette, detectPreferredTheme, findBuiltinTheme } from "./theme/theme";
import { findTheme } from "./theme/theme-files";
import { codeStyleFromEnvironment, setCodeStyle } from "./render/syntax";
import { resolveControlLanguage } from "./platform/i18n";
import { resolveGlyphs } from "./text/glyphs";
import { loadMemories, type MemoryEntry } from "./commands/memory";
import { type PaceLevel } from "./commands/pacing";
import { CliStateHistory } from "./session/state-history";
import { confirmSpendingCap, createApprovalPrompt, hiddenQuestion, questionWithEscape } from "./app/prompts";
import { readFxRates } from "./app/providers";
import { runJobWorkerProcess } from "./app/job-launch";
import { runInformationFlag, runMaintenanceFlag } from "./app/startup-commands";
import { settleDisplayCurrency, type CurrencyState } from "./app/display-currency";
import type { SessionState } from "./app/session-state";
import { createWorkspaceFactory } from "./app/workspaces";
import { createBalanceTracking } from "./app/balance-tracking";
import { createClientFactory } from "./app/agent-factory";
import type { TabPayload } from "./app/session-state";
import { readCachedLiveModels } from "./app/live-models";
import { createSessionHints } from "./app/session-hints";
import { createTurnRunner } from "./app/turn-runner";
import type { RecoverableTurn } from "./app/session-state";
import { createSigintHandling } from "./app/interrupts";
import { resumeAtStartup, runOneShot } from "./app/session-start";

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
      // Silent: in ACP mode stdout is the protocol, so sandbox progress must not be printed there.
      ...(args.backend !== "local" ? { createWorkspace: () => createWorkspaceFactory(args, environment)({ backend: args.backend, announce: false }) } : {}),
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

  // The interactive interface is the Go program (cmd/friday), which runs this one as its agent
  // over ACP. Reached here with nothing to do, this process says where the interface is.
  if (!args.prompt) {
    // From the npm launcher on a platform without the Go binary: why, and how to fix it.
    const missing = environment.ARCHYMEDES_INTERFACE_MISSING?.trim();
    if (missing) {
      process.stderr.write(`${missing}\n`);
      await stateHistory.close();
      return EXIT_CODES.usage;
    }
    process.stderr.write(`${style.red("This is the Friday agent, not its interface.")} Run ${style.cyan("friday")} from npm for the interactive interface (${style.cyan("bun run friday")} in a checkout), or pass a request to run one turn: friday "your request".\n`);
    await stateHistory.close();
    return EXIT_CODES.usage;
  }

  let resolved = await resolveSessionProvider(environment, args);
  // With nothing configured, `resolveProvider` has already fallen back to keyless free mode when
  // this build (FREE_GATEWAY_URL) or the environment (ARCHYMEDES_FREE_GATEWAY_URL) names a free
  // gateway. An error that reaches here without an explicit selection means neither exists. In a
  // real terminal that is not a dead end: a short guided setup gets a free OpenRouter key, saves
  // it, and carries on into the session (see `runFreeModeSetup`) — never the full settings menu.
  // A pipe or --json run has nobody to answer, so it keeps the message and the non-zero exit.
  if ("error" in resolved && !args.provider && !args.model && !args.json && process.stdin.isTTY && process.stdout.isTTY) {
    const setupReadline = createInterface({ input: process.stdin, output: process.stdout, terminal: true, escapeCodeTimeout: escapeCodeTimeoutMs() });
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
    process.stderr.write(`${style.red("Friday is not configured.")} Free mode is not available in this build: set ${style.cyan("ARCHYMEDES_FREE_GATEWAY_URL")} to a free gateway URL to run without a key.\n`);
    process.stderr.write(style.dim(`Or set ${style.cyan("OPENROUTER_API_KEY")} to a free key from https://openrouter.ai/keys (in a terminal, ${style.cyan("friday")} guides you through it), or run ${style.cyan("friday settings")} to add a provider key.\n`));
    await stateHistory.close();
    return args.json ? EXIT_CODES.usage : 1;
  }
  if (!("error" in resolved) && resolved.spec.id === "free" && !args.provider && environment.ARCHYMEDES_PROVIDER?.trim() !== "free" && !args.json) {
    out.write(style.dim("Running free models with no key. Add your own provider key any time with friday settings.\n"));
  }
  if ("error" in resolved) {
    process.stderr.write(`${style.red("Friday is not configured.")} ${resolved.error}\n`);
    process.stderr.write(`Run ${style.cyan("friday settings")} to save a key without exporting one.\n`);
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

  // Only for the approval and spending questions a one-shot run in a terminal may still ask.
  const readline = createInterface({ input: process.stdin, output: process.stdout, escapeCodeTimeout: escapeCodeTimeoutMs() });
  const interactive = Boolean(process.stdin.isTTY);
  // The spinner redraws over the current line — meaningless (and corrupting) output when either
  // end of the pipe is not a real terminal.
  const ttyMode = interactive && !args.json && Boolean(process.stdout.isTTY);
  const depth = detectColorDepth(environment, !args.json && Boolean(process.stdout.isTTY));
  const sessionGlyphs = args.ascii ? resolveGlyphs({ ...environment, ARCHYMEDES_GLYPHS: "ascii" }) : resolveGlyphs(environment);
  // A name that matches nothing is reported rather than substituted silently: a theme that does
  // not exist is nearly always a typo.
  let themeName = args.theme ?? detectPreferredTheme(environment);
  let activeTheme = await findTheme(themeName, args.root, environment);
  if (!activeTheme && args.theme) {
    out.write(style.yellow(`  No theme named "${args.theme}" — using ${DEFAULT_THEME_NAME}.\n`));
  }
  if (!activeTheme) {
    activeTheme = await findTheme(DEFAULT_THEME_NAME, args.root, environment);
    themeName = DEFAULT_THEME_NAME;
  }
  configureRendering(depth, !args.json && Boolean(process.stdout.isTTY), sessionGlyphs,
    activeTheme ? buildPalette(activeTheme, depth) : NO_COLOR_PALETTE);
  let mode = args.mode;
  let pace: PaceLevel = args.pace;
  let memories: MemoryEntry[] = await loadMemories(args.root, environment);
  let projectFiles: string[] = [];

  let exitCleanly = () => { readline.close(); };

  const approvedBudget = args.budget ? fromUnits(args.budget, display) : undefined;
  if (approvedBudget && !await confirmSpendingCap(readline, interactive, formatMoney(approvedBudget))) {
    out.write(style.yellow("  Spending not approved — no sandbox or model was started.\n"));
    exitCleanly();
    return 0;
  }

  let workspace: ArchymedesWorkspace;
  {
    const started = args.estimateOnly
      ? { workspace: new LocalWorkspace(args.root) }
      : await createWorkspaceFactory(args, environment)({ backend: args.backend });
    if ("error" in started) {
      process.stderr.write(`${style.red(started.error)}\n`);
      exitCleanly();
      return 1;
    }
    workspace = started.workspace;
  }

  let ledger = new CostLedger({
    prices,
    display,
    rates,
    catalog: PRICE_CATALOG,
    ...(approvedBudget ? { budget: approvedBudget } : {}),
  });

  const { balanceWatch, parseManualBalance, currentBalance, persistManualBalance, sessionSpend, balanceHeader, checkBalance, carryResumedSpend } =
    createBalanceTracking({ root: args.root, environment, processEnvironment, rates, state });
  let manualBalance = parseManualBalance(environment.ARCHYMEDES_ACCOUNT_BALANCE, environment.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY);

  // Read at ask-time by `createApprovalPrompt`: replaced every turn (an `AbortSignal` is single-use).
  let currentTurnAbort: AbortController | undefined;
  let pendingReadAbort: AbortController | undefined;
  const approvalPrompt = createApprovalPrompt(readline, interactive, () => currentTurnAbort?.signal);
  const handleDaemonNotification = (notification: DaemonNotification) => {
    // `client.send()` already returns the turn's outcome, so only the event stream is forwarded.
    if (notification.type !== "agent_event") return;
    const event = notification.event;
    if (event.type === "runtime" && event.event.type === "assistant_delta") streamedAnswer = true;
    headless?.agentEvent(event);
    renderEvent(event);
  };
  /** One coordinator owns every live agent this process creates; see `app/agent-factory.ts`. */
  const daemon = new ArchymedesSessionDaemon();
  const openClient = createClientFactory({ args, environment, daemon, approvalPrompt, onNotification: handleDaemonNotification, rates, approvedBudget, state });
  // Human rendering still runs in headless mode — its output is the stderr diagnostic stream.
  const headless = writeRecord ? new HeadlessEmitter(writeRecord) : null;
  let agent = await openClient();

  const tabs = new WorkspaceController<TabPayload>();
  const firstSink = new TabSink(sessionStream, { live: true });
  tabs.adopt(path.basename(args.root) || "archymedes", {
    agent, ledger, mode, sink: firstSink,
    provider: model, spec, prices, modelId: resolvedModelId,
    backend: args.backend, workspace, ownsWorkspace: false,
  });
  out.route(firstSink);
  let explainedTabs = false;

  /** Models the providers report beyond this build's own list; see `app/live-models.ts`. */
  let liveModels: Partial<Record<ProviderId, string[]>> = {};
  await readCachedLiveModels(environment, state);

  if (args.estimateOnly) {
    out.write(`${ledger.formatPrediction(await agent.estimate(args.prompt))}\n`);
    await agent.dispose();
    exitCleanly();
    return 0;
  }

  const resumeFailure = await resumeAtStartup({ args, interactive, stateHistory, state, openClient, exitCleanly: () => exitCleanly(), carryResumedSpend });
  if (resumeFailure !== undefined) return resumeFailure;

  // Ctrl-C interrupts the turn rather than the process; see `app/interrupts.ts`.
  let turnActive = false;
  let exitRequested = false;
  let detachRequested = false;
  const { bindSigint, unbindSigint } = createSigintHandling({ readline, state, exitCleanly: () => exitCleanly() });
  bindSigint();
  const watched = new WatchRegistry();
  exitCleanly = () => { unbindSigint(); watched.stopAll(); readline.close(); };

  let wanderRunning = false;
  let lastScanFindings: number | undefined;
  let lastFailure: { status: NavContext["lastStatus"]; message: string } | null = null;
  let cacheChurnReported = false;
  const { navContext } = createSessionHints({ state, watched, tabs, usage: new CommandUsage(), interactive });
  let streamedAnswer = false;
  /** The turn's terminal status, which headless mode turns into the process exit code. */
  let lastTurnStatus: AgentRuntimeResult["status"] = "failed";
  let sessionRequest: string | undefined;
  const recoveryState: { last: RecoverableTurn | null } = { last: null };
  let lastTurnEndedAt: number | undefined;
  const where = workspace.kind === "e2b" ? `sandbox ${workspace.label.split(":")[1]}` : path.basename(args.root);

  const runTurn = createTurnRunner({
    args, environment, readline, interactive, ttyMode, depth, rates, approvedBudget, headless, stateHistory, recoveryState, state,
    balance: { currentBalance, balanceWatch, sessionSpend, persistManualBalance, checkBalance, balanceHeader },
    openClient, navContext, refreshProjectFiles: () => {},
  });
  return runOneShot({ args, interactive, stateHistory, state, openClient, exitCleanly: () => exitCleanly(), prompt: args.prompt, headless, runTurn });
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
