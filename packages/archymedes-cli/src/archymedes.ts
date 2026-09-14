#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ArchymedesAgent } from "@archymedes/core/cli/agent";
import { runAcpServer } from "./acp-server";
import { parseArgs } from "./app/args";
import { describeLocation, type SandboxBackend } from "./session/location";
import { runCat } from "./commands/cat";
import { animateBudgetMeter, renderCostReport } from "./commands/cost";
import { runHistoryCommand } from "./commands/history";
import { runTabCommand } from "./commands/tab";
import { chooseModel, rememberModelChoice } from "./commands/model";
import { runScan } from "./commands/scan";
import { describeFind, parseFindCommand } from "./commands/find";
import { runPager } from "./commands/pager";
import { FALLBACK_PROVIDERS, fallbackSetting, parseFallbackPreference } from "./session/fallback";
import { widestRow, renderPatch } from "./render/patch-view";
import { wanderArtifacts, buildWanderPrompt, gatherWanderEvidence, parseWanderCommand, renderWanderResults, wanderJobObjective } from "./commands/wander";
import { describeJobForHuman } from "./job-worker";
import { clearKittyImages, imagePreference } from "./render/image-view";
import { FOLD_AFTER_LINES, SPINNER_START_DELAY_MS, activity, beginTranscriptTurn, configureRendering, contentWidth, endStreamedLine, expandables, forgetToolLines, glyphs, liveTerminal, markdown, out, palette, renderDepth, renderEvent, renderUserTurn, screen, sectionStyle, sessionChecks, sessionFiles, sessionStream, setScreen, setSpinner, spinner, statusBar, style, surfacePaint, toolLines, touchedFiles, turnLineDelta, verificationChecks, writeFoldable } from "./app/transcript";
import { priceSessionModelTurns, readSessionModelTurns } from "./session/resumed-spend";
import { galleryVariants, renderGallery } from "./ui/gallery";
import { CommandUsage, navSignals, rankWithContext, renderAsks, renderEssentials, renderGroupedHelp, renderHint, renderRecovery, renderStarters, renderSuggestions, type NavContext } from "./ui/navigation";
import { askModelForSuggestions, mergeModelSuggestions, type Suggestion as EngineSuggestion } from "@archymedes/core/cli/suggestions";
import type { ModelUsage } from "@archymedes/core/providers/model";
import { ArchymedesSessionDaemon, type DaemonNotification, type ArchymedesDaemonClient } from "@archymedes/core/cli/daemon";
import type { ArchymedesMode } from "@archymedes/core/cli/permissions";
import { assessTaskSafety } from "@archymedes/core/cli/safety";
import { listSessions, loadSession, type SessionRecord } from "@archymedes/core/cli/session";
import { catalogPrices, PRICE_ENVIRONMENT_HINT, PROVIDER_IDS, providerEnvPrefix, resolveProvider, type ProviderId } from "@archymedes/core/providers/agent-matrix";
import { convertTo, fromUnits, toUnits, formatMoney, isCurrency, priceUsage, type Money } from "@archymedes/core/money";
import { createExaClient } from "@archymedes/core/providers/exa";
import { downloadProject, DockerWorkspace, E2BWorkspace, LocalWorkspace, uploadProject, type ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import type { AgentRuntimeResult } from "@archymedes/core/agent-runtime";
import { CostLedger } from "@archymedes/core/cli/cost";
import { EXIT_CODES, HeadlessEmitter, exitCodeForStatus } from "./headless";
import { buildModelCatalog, parseModelCommand } from "./session/models";
import { INITIAL_TABLE_STATE, renderTable } from "./ui/table";
import { buildJobsTable } from "./ui/tables";
import { PRICE_CATALOG } from "@archymedes/core/providers/price-catalog";
import { detectColorDepth } from "./text/color-depth";
import { writeIdentity } from "./render/identity";
import { WorkspaceFrame } from "./ui/workspace-frame";
import { layoutNotice, parseLayoutCommand, resolveLayout, wantsPinnedFooter, workspaceFrameOptions } from "./ui/layout-choice";
import { isTranscriptKey, transcriptScrollForKey, type ScrollKey } from "./terminal/transcript-keys";
import { setWorkspaceMenu, installShortcuts, openChooser, openDefenderTriage, openPalette, replaceLine, withBorrowedKeyboard } from "./ui/shortcuts";
import { box, CountdownTimer, formatCountdown, formatHeaderSegments, formatStatusLine, progressBar, PromptBox, PROMPT_PREFIX_COLUMNS, promptStatusRoom, renderPromptBox, Spinner, SpringAnimator, StatusBar, table } from "./render/tui";
import { dropupRowBudget, renderDropup, type DropupEntry } from "./ui/dropup";
import { visibleWidth } from "./text/text-width";
import { PinnedScreen } from "./terminal/screen";
import { renderMarkdown } from "./render/markdown";
import { completeInput, inlineCompletion, isKnownCommand, parseModeCommand, renderKeyboardShortcuts, suggestCommand, suggestionsFor } from "./catalog/commands";
import { KeyBindingRegistry, parseBindingOverrides } from "./terminal/keybindings";
import { runChooser, type ChooserItem } from "./ui/chooser";
import { doctorExitCode, doctorReport, renderDoctor, runDoctor } from "./platform/doctor";
import { renderCompletionCard } from "./render/completion-card";
import { renderTask, renderTodos, type InspectContext } from "./commands/session-inspect";
import { renderRoutingReceipt, renderRoutingSummary } from "./render/routing-receipt";
import { renderRoutingPlan } from "./render/routing-plan";
import { exportSession, type ExportFormat } from "./session/session-export";
import { hostOf, providerBaseUrl } from "./platform/endpoints";
import { fetchDailyFxRate, resolveCurrencyPreference, type FxLookupFailure } from "./platform/local-currency";
import { classifyNetworkError } from "./platform/network";
import { ARCHYMEDES_CLI_VERSION, compareVersions, fetchLatestVersion, runSelfUpdate } from "./platform/update";
import { readAutoUpdateMode, runAutoUpdate } from "./platform/auto-update";
import { updateDefenderFeed } from "./platform/defender-feed-update";
import { renderReliabilityStatus } from "./render/reliability-status";
import { CACHE_CHURN_HINT } from "@archymedes/core/cli/cost";
import { SETTING_FIELDS, loadSettings, mergedEnvironment, runSettingsMenu, saveSettings, type ArchymedesSettings } from "./platform/settings";
import { loadHistory, saveHistory } from "./session/history";
import { renderTabStrip, parseTabCommand, WorkspaceController } from "./session/tabs";
import { TabSink, replayLines } from "./terminal/output";
import { fetchableProviders, isCacheFresh, loadLiveModels, readModelCache } from "@archymedes/core/providers/model-fetch";
import { JobStream, WatchRegistry, sandboxWarning } from "./terminal/job-stream";
import { PaneActivity, tabPanes, type WorkspaceSnapshot } from "./ui/workspace-model";
import { explainScreenRefusal, withFullScreen, type ScreenCapabilities, type TerminalControls } from "./terminal/screen-host";
import { findTopic, parseGuideCommand, renderGuideIndex, renderGuideTopic, renderWholeGuide, searchTopics } from "./render/guide";
import { DEFAULT_THEME_NAME, NO_COLOR_PALETTE, buildPalette, colorCode, detectPreferredTheme, findBuiltinTheme, parseThemeCommand, rainbowHex } from "./theme/theme";
import { discoverThemes, findTheme, themeDirectory } from "./theme/theme-files";
import { WANDER_LAB_FILES } from "@archymedes/core/wander";
import { cancelJob, enqueueJob, getJob, isTerminal, jobLogPath, listJobs, newJobId, readJobLog, resolveJobApproval } from "@archymedes/core";
import { parseAttachCommand, parseDetachCommand, parseJobsCommand } from "./commands/jobs-command";
import { BalanceWatch, assessTaskBalance, formatBalance, parseManualBalanceCommand, renderBalance, renderHostedBalance } from "./commands/balance";
import type { CreditBalance as HostedCreditBalance } from "@archymedes/core/providers/credit-balance";
import { CRITICAL_BALANCE_USD, LOW_BALANCE_USD, type Balance } from "@archymedes/core/cli/balance";
import { IMPLICIT_SKILL_PROVIDER_ID } from "@archymedes/core";
import { renderTools } from "./commands/tools-command";
import { removeRecording, startRecording, transcribeAudio } from "./commands/voice";
import { resolveControlLanguage, t } from "./platform/i18n";
import { resolveGlyphs } from "./text/glyphs";
import { GUTTER, heading, note, panel, rule } from "./render/sections";
import { expandHint, parseExpandCommand, renderExpandableList } from "./render/expandable";
import { addMemory, clearMemories, describeAdded, forgetMemory, loadMemories, memoryFile, memoryPromptBlock, parseMemoryCommand, recallMemories, replaceMemory, renderMemories, type MemoryEntry } from "./commands/memory";
import { parseHistoryCommand, renderHistoryList, renderHistoryUsage, renderReplay, searchHistory, summarizeSession, type HistoryEntry } from "./commands/chat-history";
import { applyPacing, describePace, exceedsPace, paceBadge, parsePaceCommand, remainingCooldown, type PaceLevel } from "./commands/pacing";
import { CliStateHistory } from "./session/state-history";
import { type ReadlineInternals, confirmSensitiveTask, confirmSpendingCap, createApprovalPrompt, hiddenQuestion, isReadlineExit, settingsChooser } from "./app/prompts";
import { helpText } from "./app/help";
import { modelChoicesForSettingsField, modelPriceCatalogFor, readFxRates, renderProviders } from "./app/providers";
import { runJobWorkerProcess, spawnJobWorker } from "./app/job-launch";

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
  if (args.help) {
    // Cheap and side-effect-free — resolving the static binding table against overrides — so
    // building one here beats threading the interactive session's own registry all the way down to
    // a path that runs before that registry, or a session at all, exists.
    const shortcuts = new KeyBindingRegistry(parseBindingOverrides(environment.ARCHYMEDES_KEYS), environment).shortcutLabels();
    out.write(helpText(language, shortcuts));
    return 0;
  }

  if (args.version) {
    out.write(`archymedes ${ARCHYMEDES_CLI_VERSION}\n`);
    return 0;
  }

  if (args.gallery) {
    // Drawn at the real terminal's width and glyph set, because the point is to see what this
    // terminal does with it. `gallery all` adds the fallback matrix: ASCII, no colour and narrow.
    const width = Math.max(24, (process.stdout.columns ?? 80) - 1);
    const here = { width, depth: earlyDepth, glyphs: args.ascii ? resolveGlyphs({ ...environment, ARCHYMEDES_GLYPHS: "ascii" }) : resolveGlyphs(environment) };
    const variants = args.prompt === "all" ? galleryVariants(width) : [{ title: "", options: here }];
    for (const variant of variants) out.write(`${variant.title ? `\n== ${variant.title} ==\n` : ""}${renderGallery(variant.options)}\n`);
    return 0;
  }

  // Before anything that could print: from here on stdout is a protocol channel, and one stray
  // human-readable byte on it is a parse error the client cannot recover from.
  if (args.acp) {
    return runAcpServer({
      input: process.stdin,
      write: (line) => process.stdout.write(line),
      environment: processEnvironment,
      defaultRoot: args.root,
      mode: args.mode,
    });
  }

  if (args.update) {
    const result = await runSelfUpdate({
      checkOnly: args.checkUpdate,
      yes: args.updateYes,
      packageManager: args.packageManager,
      environment: process.env as Record<string, string | undefined>,
    });
    return result.code;
  }

  if (args.settings) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("Archymedes settings needs an interactive terminal. Environment variables remain supported for automation.\n");
      return 1;
    }
    const settingsReadline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      savedSettings = await runSettingsMenu(savedSettings, {
        ask: (question) => settingsReadline.question(question),
        askSecret: (question) => hiddenQuestion(settingsReadline, question),
        write: (text) => process.stdout.write(text),
        choose: settingsChooser(settingsReadline),
      }, {
        modelChoices: (field, current) => modelChoicesForSettingsField(field, current, processEnvironment, "USD", []),
      });
    } catch (error) {
      settingsReadline.close();
      if (isReadlineExit(error)) {
        out.write(style.dim("\nSettings cancelled — no changes were saved.\n"));
        return 0;
      }
      throw error;
    }
    const file = await saveSettings(savedSettings, processEnvironment);
    settingsReadline.close();
    out.write(`Settings saved to ${file}. Environment variables override saved values.\n`);
    return 0;
  }

  if (args.listProviders) {
    out.write(`${renderProviders(environment, detectColorDepth(environment, Boolean(process.stdout.isTTY)))}\n`);
    return 0;
  }

  if (args.doctor) {
    const depth = detectColorDepth(environment, Boolean(process.stdout.isTTY));
    const probes = await runDoctor(environment);
    if (args.doctorReport) {
      const selectedProvider = environment.ARCHYMEDES_PROVIDER?.trim();
      const selectedModel = selectedProvider && PROVIDER_IDS.includes(selectedProvider as ProviderId)
        ? environment[`${providerEnvPrefix(selectedProvider as ProviderId)}_MODEL`]
        : undefined;
      const history = await stateHistory.status().catch(() => undefined);
      process.stdout.write(`${JSON.stringify(doctorReport(probes, {
        cliVersion: ARCHYMEDES_CLI_VERSION,
        platform: process.platform,
        arch: process.arch,
        runtime: `Bun ${process.versions.bun ?? process.version}`,
        ...(selectedProvider ? { provider: selectedProvider } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        terminal: { columns: process.stdout.columns, rows: process.stdout.rows, tty: Boolean(process.stdout.isTTY) },
        ...(history ? { history: { mode: history.mode, ...(history.mode === "native" ? { indexed: history.indexed } : {}), ...(history.reason ? { reason: history.reason } : {}) } } : {}),
      }), null, 2)}\n`);
    } else {
      process.stdout.write(`${renderDoctor(probes, depth, language)}\n`);
    }
    await stateHistory.close();
    return doctorExitCode(probes);
  }

  if (args.listSessions) {
    const indexed = await stateHistory.sessions(20);
    const sessions = indexed
      ? indexed.map((session) => ({ id: session.sessionId, title: session.title, updatedAt: session.updatedAt ?? 0 }))
      : await listSessions(args.root);
    if (sessions.length === 0) out.write("No sessions in this project yet.\n");
    for (const session of sessions) {
      out.write(`${style.cyan(session.id)}  ${new Date(session.updatedAt).toLocaleString()}  ${session.title}\n`);
    }
    await stateHistory.close();
    return 0;
  }

  if (args.historyCommand) {
    const command = args.historyCommand;
    const style_ = sectionStyle();
    if (command.kind === "invalid") {
      process.stderr.write(`${command.reason}\n`);
      return EXIT_CODES.usage;
    }
    if (command.kind === "status") {
      await stateHistory.refresh();
      const status = await stateHistory.status();
      if (status.mode === "native") {
        out.write(`native SQLite + FTS5: ${status.indexed ? "current" : "ready"}\n`);
        if (status.report) out.write(`${status.report.sessions} sessions, ${status.report.documents} searchable documents, ${status.report.failures.length} source failures\n`);
      } else {
        out.write(`portable JSON history: active\n${status.reason ?? "native state engine unavailable"}\n`);
      }
      await stateHistory.close();
      return 0;
    }
    if (command.kind === "show") {
      const record = await loadSession(args.root, command.id);
      if (!record) {
        process.stderr.write(`No session ${command.id}. Run archymedes history to list them.\n`);
        return EXIT_CODES.usage;
      }
      out.write(`${renderReplay(record, style_, command.turns === undefined ? {} : { turns: command.turns })}\n`);
      return 0;
    }
    if (command.kind === "resume") {
      process.stderr.write(`Use archymedes --resume${command.id ? ` ${command.id}` : ""} to continue a session.\n`);
      return EXIT_CODES.usage;
    }

    const historyEntries = async (): Promise<HistoryEntry[]> => {
      const indexed = await stateHistory.sessions(30);
      const listed = indexed
        ? indexed.map((session) => ({ id: session.sessionId, title: session.title, updatedAt: session.updatedAt ?? 0 }))
        : await listSessions(args.root, 30);
      return (await Promise.all(listed.map(async (summary) => {
        const record = await loadSession(args.root, summary.id);
        return record ? summarizeSession(record) : null;
      }))).filter((entry): entry is HistoryEntry => entry !== null);
    };

    if (command.kind === "search") {
      const nativeHits = await stateHistory.search(command.query, 20);
      const found = nativeHits
        ? (await Promise.all(nativeHits.map(async (hit): Promise<HistoryEntry | null> => {
            const record = await loadSession(args.root, hit.sessionId);
            return record ? { ...summarizeSession(record), evidence: { source: hit.source, snippet: hit.snippet, why: hit.why } } : null;
          }))).filter((entry): entry is HistoryEntry => entry !== null)
        : searchHistory(await historyEntries(), command.query);
      out.write(`${heading(`"${command.query}" ${glyphs.middot} ${found.length} match${found.length === 1 ? "" : "es"}`, 2, style_)}\n`);
      out.write(`${renderHistoryList(found, style_)}\n`);
    } else {
      {
        const entries = await historyEntries();
        out.write(`${renderHistoryList(entries, style_)}\n`);
        const usage = renderHistoryUsage(entries, style_);
        if (usage) out.write(`${usage}\n`);
      }
    }
    await stateHistory.close();
    return 0;
  }

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

  let resolved = resolveProvider(environment, { provider: args.provider, model: args.model });
  // Nothing configured yet is the ordinary first run, not an error. Exporting a key into the shell
  // leaves it in shell history and dies with the shell; Archymedes already stores keys itself, so the
  // first run offers that instead of printing a variable name and quitting. Automation still gets
  // the message-and-exit path, because a prompt no one can answer is a hang.
  // Never in headless mode: an interactive menu has nobody to answer it when a program is driving.
  if ("error" in resolved && !args.json && !args.provider && !args.model && process.stdin.isTTY && process.stdout.isTTY) {
    out.write(`${style.yellow(t(language, "firstRun.notConfigured"))} ${style.dim("It is saved for next time, so you never need to export it.")}\n`);
    const setupReadline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      savedSettings = await runSettingsMenu(savedSettings, {
        ask: (question) => setupReadline.question(question),
        askSecret: (question) => hiddenQuestion(setupReadline, question),
        write: (text) => process.stdout.write(text),
        choose: settingsChooser(setupReadline),
      }, {
        focus: "providers",
        // The whole point of first run: the key was pasted one field ago, so the model field can
        // be a list of what that key actually reaches rather than an id to be recalled and typed.
        modelChoices: (field, current) => modelChoicesForSettingsField(field, current, processEnvironment, "USD", []),
      });
      const file = await saveSettings(savedSettings, processEnvironment);
      out.write(style.dim(`Settings saved to ${file}.\n`));
    } catch (error) {
      if (!isReadlineExit(error)) throw error;
      out.write(style.dim("\nSetup cancelled.\n"));
    } finally {
      setupReadline.close();
    }
    // The freshly saved values have to reach the same merged view every later read uses, or the
    // key the user just typed would be invisible for the rest of this process.
    for (const field of SETTING_FIELDS) delete environment[field.key];
    Object.assign(environment, mergedEnvironment(savedSettings, processEnvironment));
    language = resolveControlLanguage(args.language ?? environment.ARCHYMEDES_LANGUAGE ?? environment.LANG);
    resolved = resolveProvider(environment, { provider: args.provider, model: args.model });
    // Archimedes' word for the moment the missing piece is found: the key is in, the tool can run.
    if (!("error" in resolved)) {
      out.write(`${style.green(style.bold("Eureka."))} ${style.dim(`${resolved.spec.label} \u00b7 ${resolved.model}`)}
`);
    }
  }
  if ("error" in resolved) {
    process.stderr.write(`${style.red("Archymedes is not configured.")} ${resolved.error}\n`);
    process.stderr.write(`Run ${style.cyan("archymedes settings")} to save a key without exporting one.\n`);
    return args.json ? EXIT_CODES.usage : 1;
  }
  let { provider: model, spec, prices } = resolved;
  let resolvedModelId = resolved.model;

  // Display currency: explicit flags/configuration, then a coarse locale country, then the
  // provider's own currency. Accounting remains in the provider currency with the dated rate
  // attached to every converted report.
  const preference = resolveCurrencyPreference({ currency: args.currency, country: args.country, environment, providerCurrency: prices?.currency ?? "USD" });
  let display = preference.currency;
  const rates = readFxRates(environment);
  let localCurrencyWarning: string | null = null;
  if (prices && display !== prices.currency) {
    const configured = rates.some((rate) => (rate.from === prices!.currency && rate.to === display) || (rate.to === prices!.currency && rate.from === display));
    const fxFailures: FxLookupFailure[] = [];
    if (!configured && environment.ARCHYMEDES_FX_OFFLINE !== "true") {
      const daily = await fetchDailyFxRate(prices.currency, display, undefined, (failure) => fxFailures.push(failure));
      if (daily) rates.push(daily);
    }
    const convertible = rates.some((rate) => (rate.from === prices!.currency && rate.to === display) || (rate.to === prices!.currency && rate.from === display));
    if (!convertible) {
      const tried = fxFailures.map((failure) => `${failure.host}: ${failure.diagnosis.message}`).join(" ");
      if (args.budget) {
        process.stderr.write(`${style.red("Cannot enforce the approved budget.")} No ${prices.currency}→${display} exchange rate is available${tried ? ` — the automatic lookup failed (${tried})` : ""}.\n`);
        process.stderr.write(`  ${style.dim(`Continue offline with a manual rate: set ARCHYMEDES_FX_FROM / ARCHYMEDES_FX_TO / ARCHYMEDES_FX_RATE, or keep costs in the provider currency with --currency ${prices.currency}. Run archymedes --doctor to see exactly which endpoint is failing.`)}\n`);
        return 1;
      }
      localCurrencyWarning = `No current ${prices.currency}→${display} rate was available${tried ? ` (${tried})` : ""}; costs remain in ${prices.currency}.`;
      display = prices.currency;
    }
  }
  if (args.budget && !prices) {
    process.stderr.write(`${style.red("Cannot enforce the approved budget.")} This model has no configured price. Configure its rate or omit --budget.\n`);
    return 1;
  }

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
  let exitCleanly = () => { screen?.exit(); setWorkspaceMenu(undefined); unbindFixedNavigation(); uninstallShortcuts(); readline.close(); abandonPrompt(); };

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

  /**
   * Somewhere for a tab's work to happen.
   *
   * Was a single workspace built once for the whole session; it is now a factory, because a tab is
   * allowed to run somewhere else. "Run this one in a throwaway sandbox and that one against my
   * checkout" is the thing a control panel is for, and it is only a factory call away once the
   * construction stops being a straight line through `main`.
   *
   * Each remote workspace is a *separate* sandbox with its own lifetime, so closing a tab stops
   * paying for exactly that one. Errors are returned rather than thrown: a tab that cannot start a
   * sandbox must report why and leave the session alone, where the startup path used to be entitled
   * to exit the process.
   */
  type WorkspaceRequest = { backend: SandboxBackend; upload?: boolean; dockerImage?: string; preset?: string; announce?: boolean };
  const createWorkspace = async (request: WorkspaceRequest): Promise<{ workspace: ArchymedesWorkspace } | { error: string }> => {
    const announce = (text: string) => { if (request.announce !== false) out.write(style.dim(`${text}\n`)); };
    const minutes = Math.max(1, Math.min(args.sandboxMinutes, 60));

    if (request.backend === "e2b") {
      // Imported here, not at the top: a local-only session should never load the E2B SDK, which is
      // what lets the published package treat it as an optional dependency.
      const { findWorkspacePreset } = await import("@archymedes/core/sandbox-templates");
      const { createE2BProvider } = await import("@archymedes/core/providers/factory");
      const preset = findWorkspacePreset(request.preset ?? args.preset);
      const sandbox = createE2BProvider(environment, preset.templateAlias);
      if (!sandbox) return { error: "Remote sandboxes need E2B. Set E2B_API_KEY (and E2B_CODING_TEMPLATE for a custom image)." };
      announce(`Starting an E2B sandbox (${preset.label}, ${minutes}m)…`);
      let session;
      try {
        session = await sandbox.createSandbox({ taskId: `archymedes_${Date.now()}`, template: "coding", maxRuntimeSeconds: minutes * 60 });
      } catch (error) {
        return { error: `E2B could not start: ${error instanceof Error ? error.message : String(error)}` };
      }
      const created = new E2BWorkspace({
        sandbox,
        sandboxId: session.sandboxId,
        workspaceRoot: "/workspace/repo",
        // Stopped rather than suspended: a CLI session that ends has no next step to resume into,
        // and a sandbox left paused keeps costing the user something they cannot see.
        onDispose: (id) => sandbox.stopSandbox(id),
      });
      announce(`  sandbox ${session.sandboxId} — files stay there, not on this machine`);
      if (request.upload ?? args.upload) {
        const uploaded = await uploadProject(created, args.root);
        announce(`  uploaded ${uploaded.uploaded.length} files${uploaded.skipped.length > 0 ? `, skipped ${uploaded.skipped.length}` : ""}`);
      }
      return { workspace: created };
    }

    if (request.backend === "docker") {
      // Same late import as E2B above, for the same reason: a local session should not pay to load
      // a backend it will never use.
      const { createDockerProvider } = await import("@archymedes/core/providers/factory");
      const image = request.dockerImage || args.dockerImage || environment.DOCKER_CODING_IMAGE;
      // The flag wins over the environment variable, but either can name the image.
      const sandbox = createDockerProvider({ ...environment, DOCKER_CODING_IMAGE: image });
      if (!sandbox) return { error: "Could not start a Docker sandbox. Pass --docker-image or set DOCKER_CODING_IMAGE." };
      announce(`Starting a Docker container (${image}, ${minutes}m)…`);
      let session;
      try {
        session = await sandbox.createSandbox({ taskId: `archymedes_${Date.now()}`, template: "coding", maxRuntimeSeconds: minutes * 60 });
      } catch (error) {
        // Docker missing, daemon not running, or image not pullable — all of them land here, and all
        // of them are worth saying plainly rather than as an unhandled rejection stack.
        return { error: `Docker could not start: ${error instanceof Error ? error.message : String(error)}. Check that Docker is installed and running, and that the image exists.` };
      }
      const created = new DockerWorkspace({
        sandbox,
        sandboxId: session.sandboxId,
        workspaceRoot: "/workspace/repo",
        onDispose: (id) => sandbox.stopSandbox(id),
      });
      announce(`  container ${session.sandboxId} — files stay there, not on this machine`);
      if (request.upload ?? args.upload) {
        const uploaded = await uploadProject(created, args.root);
        announce(`  uploaded ${uploaded.uploaded.length} files${uploaded.skipped.length > 0 ? `, skipped ${uploaded.skipped.length}` : ""}`);
      }
      return { workspace: created };
    }

    return { workspace: new LocalWorkspace(args.root) };
  };

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

  // The tracked balance is a figure the user sets with /balance, kept in the session's display
  // currency and drawn down by the measured cost of each turn. It is deliberately separate from
  // the session cap: the cap is a hard local guard, this is a soft "am I running low" watch.
  const usdInDisplay = (usd: number): number => {
    const converted = convertTo(fromUnits(usd, "USD"), display, rates);
    return converted ? toUnits(converted) : usd;
  };
  const configuredLowBalance = Number(environment.ARCHYMEDES_LOW_BALANCE);
  const configuredCriticalBalance = Number(environment.ARCHYMEDES_CRITICAL_BALANCE);
  const lowBalance = Number.isFinite(configuredLowBalance) && configuredLowBalance >= 0 ? configuredLowBalance : usdInDisplay(LOW_BALANCE_USD);
  const criticalBalance = Number.isFinite(configuredCriticalBalance) && configuredCriticalBalance >= 0 ? configuredCriticalBalance : usdInDisplay(CRITICAL_BALANCE_USD);
  const balanceWatch = new BalanceWatch({ lowBalance, criticalBalance });

  const parseManualBalance = (value: string | undefined, currencyValue?: string): Balance | undefined => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return undefined;
    const currency = currencyValue?.trim().toUpperCase();
    return { amount, currency: currency && isCurrency(currency) ? currency : display, asOf: Date.now() };
  };
  let manualBalance = parseManualBalance(environment.ARCHYMEDES_ACCOUNT_BALANCE, environment.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY);
  const currentBalance = (): Balance | undefined => manualBalance;
  const persistManualBalance = async (next: Balance | undefined): Promise<string> => {
    if (next === undefined) {
      delete savedSettings.ARCHYMEDES_ACCOUNT_BALANCE;
      delete savedSettings.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY;
    } else {
      savedSettings.ARCHYMEDES_ACCOUNT_BALANCE = String(next.amount);
      savedSettings.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY = next.currency;
    }
    const file = await saveSettings(savedSettings, processEnvironment);
    manualBalance = next;
    if (next === undefined) {
      delete environment.ARCHYMEDES_ACCOUNT_BALANCE;
      delete environment.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY;
    } else {
      environment.ARCHYMEDES_ACCOUNT_BALANCE = String(next.amount);
      environment.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY = next.currency;
    }
    return file;
  };
  const sessionSpend = (): number | undefined => {
    const total = ledger.displayTotal;
    return total ? toUnits(convertTo(total, display, rates) ?? total) : undefined;
  };

  const balanceHeader = (): { full: string; compact: string } => {
    const balance = currentBalance();
    if (!balance) return { full: "", compact: "" };
    const paintBalance = balance.amount < criticalBalance ? style.red : balance.amount <= lowBalance ? style.yellow : style.green;
    const text = formatBalance(balance.amount, balance.currency);
    return { full: `${style.dim("balance")} ${paintBalance(text)}`, compact: paintBalance(`~${text}`) };
  };
  const checkBalance = async (silent = false): Promise<void> => {
    const balance = currentBalance();
    if (!balance) return;
    const alert = balanceWatch.observe(balance, {
      sessionSpend: sessionSpend(),
      sessionTurns: ledger.history.length,
      silent,
    });
    if (alert) for (const line of alert.lines) out.write(`  ${style.yellow(line)}\n`);
  };

  /**
   * Tells the current tab's ledger what the session being resumed has already spent.
   *
   * Without this a budget is a per-process cap wearing a per-session label: the ledger the cap is
   * checked against starts this process at zero, so every resume hands back the whole allowance.
   * Rebuilt from the session's event journal rather than read off the record — see
   * `resumed-spend.ts` for why the record's own running total is not a currency. Reads `ledger`
   * and `prices` at call time rather than capturing them, because switching tabs replaces both.
   */
  const carryResumedSpend = async (record: SessionRecord): Promise<void> => {
    const turns = await readSessionModelTurns(args.root, record.id).catch((error: unknown) => {
      // A journal that fails its integrity check is a reason to distrust the figure, not to
      // invent one. Say so: a budget silently starting over is the failure this exists to prevent.
      out.write(style.yellow(`  Could not read this session's earlier spend (${error instanceof Error ? error.message : String(error)}); the budget below counts only this run.\n`));
      return null;
    });
    if (!turns || turns.length === 0) return;
    const { spent, unpriced } = priceSessionModelTurns(turns, {
      display,
      rates,
      // The catalog first, since it knows what each model the session actually used costs; the
      // current session's own rate card only as a fallback for a model it has never heard of.
      pricesFor: (model) => catalogPrices(spec.id, model) ?? (model === resolvedModelId ? prices : undefined),
    });
    if (unpriced.length > 0) {
      out.write(style.yellow(`  No published rate for ${unpriced.join(", ")}; this session's earlier spend is counted as at least what is shown.\n`));
    }
    if (spent && spent.micros > 0) ledger.carryForward(record.id, spent);
  };

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
  /**
   * One coordinator owns every live agent this process creates.
   *
   * Tabs, mode swaps and model swaps each become a daemon client rather than a directly-held
   * `ArchymedesAgent`, which is what makes this process's sessions reachable the same way a desktop
   * window's or an IDE's are — through `ArchymedesSessionDaemon`, not through a second, parallel way of
   * constructing an agent that the daemon knows nothing about.
   */
  const daemon = new ArchymedesSessionDaemon();
  /**
   * Builds an agent for a tab.
   *
   * The overrides exist because a tab may not be running what the session is: its own model, its
   * own prices, its own machine. Defaulted to the locals so every existing call site — a mode
   * switch, a `/clear`, a resume — keeps meaning "rebuild the tab I am in".
   */
  const openClient = async (
    record?: SessionRecord,
    runtime: { provider?: typeof model; prices?: typeof prices; workspace?: ArchymedesWorkspace } = {},
  ): Promise<ArchymedesDaemonClient> => {
    const client = daemon.connect({
      onNotification: handleDaemonNotification,
      // The daemon's approval type is the flattened cross-boundary shape; the terminal prompt reads
      // `summary`, `safety` and (for a pending write/edit) `preview` off it.
      approve: (request) => approvalPrompt({ summary: request.summary, safety: request.safety, preview: request.preview }),
    });
    await client.open(({ onEvent, approve }) => new ArchymedesAgent({
      root: args.root,
      model: runtime.provider ?? model,
      // The runtime keeps its own integer-unit ceiling as a runaway guard; the ledger below owns the
      // real, currency-aware budget. Feeding it the provider's own per-million rates keeps that guard
      // proportionate to actual spend instead of to a unit nobody configured.
      prices: modelPriceCatalogFor(runtime.prices ?? prices, Boolean(approvedBudget)),
      // The pace's limits are the runtime's own budget fields, merged over the approved cap rather
      // than replacing it: slowing down must never quietly raise a ceiling the user approved.
      budgets: applyPacing(
        approvedBudget && (runtime.prices ?? prices) ? { maxRwf: convertTo(approvedBudget, (runtime.prices ?? prices)!.currency, rates)?.micros ?? approvedBudget.micros } : {},
        pace,
      ),
      mode,
      workspace: runtime.workspace ?? workspace,
      approve,
      search: createExaClient(environment),
      onExpense: (expense) => ledger.recordExpense(expense),
      onEvent,
    }), record);
    return client;
  };
  // Human rendering still runs in headless mode — its output is the stderr diagnostic stream —
  // so a person watching a piped run sees the same narration a caller's parser ignores.
  const headless = writeRecord ? new HeadlessEmitter(writeRecord) : null;
  let agent = await openClient();

  /**
   * One workspace, several pieces of work.
   *
   * Each tab owns its own agent, cost ledger, mode — and its own output sink. Switching swaps the
   * three locals the rest of this loop already reads, and re-points `out` at the incoming tab.
   * Threading a tab handle through every call site instead would touch every line below without
   * changing what any of them do.
   *
   * The sink is what makes a tab a *place* rather than a saved setting: what a tab printed stays
   * addressable after you leave it, so coming back can show where you were instead of an empty
   * screen and a prompt.
   */
  /**
   * Everything that makes one tab a different piece of work from another.
   *
   * Model, provider and workspace joined `agent`/`ledger`/`mode` here because a control panel whose
   * every panel runs the same model in the same place is just a list. A tab on Sonnet against this
   * checkout and a tab on an open model in a throwaway sandbox are the case this exists for, and
   * they are only different if these travel with the tab rather than with the session.
   *
   * `ownsWorkspace` marks the tabs that started their own sandbox. The session's original workspace
   * is shared — closing the tab that happens to hold it must not dispose the thing every other tab
   * is still using — while a sandbox a tab started is a sandbox a tab stops paying for.
   */
  type TabPayload = {
    agent: ArchymedesDaemonClient;
    ledger: CostLedger;
    mode: ArchymedesMode;
    sink: TabSink;
    provider: typeof model;
    spec: typeof spec;
    prices: typeof prices;
    modelId: string;
    backend: SandboxBackend;
    workspace: ArchymedesWorkspace;
    ownsWorkspace: boolean;
  };

  /** What the strip and the workspace show about a tab, from what only this file knows. */
  const describeTab = (payload: TabPayload) => ({
    model: payload.modelId,
    backend: payload.backend,
    cost: payload.ledger.displayTotal ? formatMoney(payload.ledger.displayTotal) : "",
  });
  const tabs = new WorkspaceController<TabPayload>();

  /**
   * How much of a tab's own transcript is reprinted when you return to it.
   *
   * Enough to re-establish where the work was, not so much that switching tabs buries the thing you
   * switched in order to do. The full record is still in the tab's sink; this is the reminder.
   */
  const REPLAY_LINES = 24;

  /** Writes the shared locals back into the tab being left, and takes it off the terminal. */
  const stashActiveTab = (): void => {
    const current = tabs.active;
    current.payload.agent = agent;
    current.payload.ledger = ledger;
    current.payload.mode = mode;
    current.payload.provider = model;
    current.payload.spec = spec;
    current.payload.prices = prices;
    current.payload.modelId = resolvedModelId;
    current.payload.workspace = workspace;
    current.payload.sink.setLive(false);
  };

  /**
   * Makes a tab the one in front: its state becomes the shared locals, and its sink becomes the
   * address every write in this file resolves to.
   */
  const enterTab = (tab: { title: string; payload: TabPayload }, options: { replay?: boolean } = {}): void => {
    ({ agent, ledger, mode, workspace } = tab.payload);
    model = tab.payload.provider;
    spec = tab.payload.spec;
    prices = tab.payload.prices;
    resolvedModelId = tab.payload.modelId;
    tab.payload.sink.setLive(true);
    out.route(tab.payload.sink);
    if (screen instanceof WorkspaceFrame) screen.scroll({ kind: "live" });
    else if (options.replay) replayTab(tab);
  };

  /**
   * Reprints the tail of a tab's transcript on return.
   *
   * Printed *through* the sink like anything else, so the replay itself becomes part of that tab's
   * record — a tab's history stays a truthful account of what its screen has shown, rather than a
   * log that quietly disagrees with the terminal.
   */
  function replayTab(tab: { title: string; payload: TabPayload }): void {
    const replay = replayLines(tab.payload.sink.log, REPLAY_LINES);
    if (replay.lines.length === 0) return;
    const above = replay.omitted + replay.dropped;
    out.write(`${rule(sectionStyle(), {
      label: tab.title,
      tone: "accent",
      ...(above > 0 ? { trailing: `${above} earlier lines above` } : {}),
    })}\n`);
    for (const line of replay.lines) out.write(`${line}\n`);
  }

  const firstSink = new TabSink(sessionStream, { live: true });
  tabs.adopt(path.basename(args.root) || "archymedes", {
    agent, ledger, mode, sink: firstSink,
    provider: model, spec, prices, modelId: resolvedModelId,
    backend: args.backend, workspace, ownsWorkspace: false,
  });
  out.route(firstSink);

  const switchTab = (id: number): boolean => {
    if (tabs.active.id === id) return Boolean(tabs.find(id));
    stashActiveTab();
    const next = tabs.activate(id);
    if (!next) {
      // Nothing was switched to, so the tab that was just stashed is still the one in front.
      enterTab(tabs.active);
      return false;
    }
    enterTab(next, { replay: true });
    return true;
  };
  /** Whether this session has already explained that a background tab is paused rather than working. */
  let explainedTabs = false;

  const showTabs = () => {
    // Detail on: once tabs can differ in model and location, which is which is the only thing the
    // strip is actually being read for.
    const strip = renderTabStrip(tabs.views(describeTab), { width: contentWidth(), glyphs, detail: true });
    if (strip) out.write(`  ${style.dim(strip)}\n`);
  };

  /**
   * What the pinned footer shows between turns: not the spinner's "thinking" line, which only
   * exists while one is active, but the quieter facts worth having pinned at rest — mode, the tab
   * strip when there is more than one, and the running total. Redrawn once per prompt cycle (see
   * the loop below) rather than pushed from every command that could change one of these, the same
   * way a real status bar settles on its next natural repaint instead of being wired to every
   * mutation site.
   */
  const idleStatusLine = (): string => {
    const strip = tabs.size > 1 ? `${renderTabStrip(tabs.views(describeTab), { width: screen?.current.columns ?? 80, glyphs })} ${glyphs.middot} ` : "";
    const cost = ledger.displayTotal ? formatMoney(ledger.displayTotal) : "cost unknown";
    const badge = pace === "off" ? "" : ` ${style.yellow(paceBadge(pace, glyphs))}`;
    const remembered = memories.length > 0 ? ` ${style.dim(`${glyphs.middot} ${memories.length} remembered`)}` : "";
    const balance = balanceHeader();
    const room = screen ? statusRoomFor(screen.current.columns) : process.stdout.columns ?? 80;
    return formatHeaderSegments([
      balance,
      ...(strip ? [{ full: strip.trim() }] : []),
      { full: `${style.cyan(mode)}${badge}`, compact: style.cyan(mode) },
      { full: style.dim(cost) },
      ...(remembered ? [{ full: remembered.trimStart() }] : []),
    ], room, ` ${glyphs.middot} `);
  };

  /**
   * The idle line, on whichever footer this session has.
   *
   * With `--pin` it goes to the reserved row; without one it is drawn by `StatusBar`, which erases
   * and redraws itself in place — the same information, at the cost of living in the flow of the
   * transcript rather than above it, and with the terminal's own scrollback left intact.
   */
  /**
   * How a full-screen view borrows the terminal. One definition, used by every screen, because the
   * six steps have to happen in the same order every time and a missed one leaves a dead prompt.
   */
  const terminalControls = (): TerminalControls => ({
    clearStatus: () => statusBar.clear(),
    releaseScreen: () => { screen?.exit(); setWorkspaceMenu(undefined); },
    uninstallShortcuts: () => uninstallShortcuts(),
    installShortcuts: () => installShortcutsAgain(),
    pauseInput: () => readline.pause(),
    resumeInput: () => readline.resume(),
    restoreScreen: () => { screen?.enter(); if (screen instanceof WorkspaceFrame) setWorkspaceMenu(screen.menu); bindFixedNavigation(); showIdleStatus(); },
  });

  const screenCapabilities = (): ScreenCapabilities => ({
    interactive: interactive && Boolean(process.stdout.isTTY),
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });

  /**
   * One small, tool-less call to the session's own model to explain a file — the editor's AI tab.
   *
   * Same shape as `modelSuggestions` below: no tools, a hard cap on output, and the usage billed to
   * the ledger as its own tiny turn rather than swallowed, since unlike a suggestion this is a call
   * the reader asked for by name and would reasonably expect to see costed.
   */
  const explainCode = async (content: string, target: string): Promise<string> => {
    const started = Date.now();
    const turn = await model.complete({
      messages: [
        { role: "system", content: "Explain the given source file to a developer reading it for the first time. Cover what it does, its key functions or exports, and any non-obvious design decisions. Plain prose, no code fences, under 200 words." },
        { role: "user", content: `File: ${target}\n\n${content}` },
      ],
      tools: [],
      maxOutputTokens: 500,
      safetyIdentifier: agent.sessionId,
    });
    ledger.record({ usage: turn.usage, iterations: 1, toolCalls: 0, elapsedMs: Date.now() - started });
    return turn.content.trim() || "The model returned no explanation.";
  };

  /**
   * Opens a file in the built-in editor and writes it back if it was saved.
   *
   * Reads and writes through the workspace rather than `node:fs`, so `/edit` works identically
   * against a remote sandbox — the same rule every tool follows. The file is only written when the
   * editor reports a save, so quitting really is a discard.
   */
  const editFile = async (target: string): Promise<void> => {
    let existing = "";
    try {
      existing = (await workspace.readFile(target, {})).content;
    } catch (error) {
      // A missing path is a new file, which is the ordinary way `nano somefile` is used. Anything
      // else — a directory, a permission error — is reported rather than silently starting blank.
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|ENOENT|no such file/i.test(message)) {
        out.write(style.yellow(`  Cannot open ${target}: ${message}\n`));
        return;
      }
    }
    let saved: string | undefined;
    const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
      const { runEditorScreen } = await import("./ui/editor-screen");
      saved = await runEditorScreen({
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        path: target,
        content: existing,
        palette,
        explain: explainCode,
      });
    });
    if (!outcome.ok) { out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`)); return; }
    if (saved === undefined) { out.write(style.dim(`  ${target} left unchanged.\n`)); return; }
    if (saved === existing) { out.write(style.dim(`  ${target} saved with no changes.\n`)); return; }
    const result = await workspace.writeFile(target, saved);
    out.write(style.green(`  Saved ${result.path} (${result.bytesWritten} bytes).\n`));
  };

  /**
   * Models the providers themselves report, over and above the ones this build was compiled with.
   *
   * Held for the session and filled on first use, so completion and the picker widen without any
   * of them paying for a request. A failure leaves it empty, which is exactly the behaviour the
   * CLI had before fetching existed.
   */
  let liveModels: Partial<Record<ProviderId, string[]>> = {};

  /**
   * Fills `liveModels`, from cache when it is fresh and from the providers otherwise.
   *
   * Never called at startup. A CLI that reaches the network before drawing its first prompt is a
   * CLI whose launch time depends on someone else's DNS, and the only thing the request buys is a
   * longer list in a menu that may never be opened. The cache is read at startup — that is free —
   * and the request happens the first time the list is actually wanted.
   */
  const refreshLiveModels = async (options: { refresh?: boolean } = {}): Promise<{ errors: string[] }> => {
    const providers = fetchableProviders(environment, PROVIDER_IDS);
    if (providers.length === 0) return { errors: [] };
    const loaded = await loadLiveModels(providers, environment, options);
    if (Object.keys(loaded.models).length > 0) liveModels = loaded.models;
    return {
      errors: loaded.errors
        // Ollama needs no key, so it is always "configured" and is always asked — a free probe of
        // localhost that costs nothing when nothing is listening. Reporting that refusal is a
        // different matter: to everyone not running Ollama it is a warning about a provider they
        // have never heard of, printed every time they ask to see the model list. It is only worth
        // saying when they pointed Archymedes at an Ollama server and it did not answer.
        .filter((error) => error.provider !== "ollama" || Boolean(environment.OLLAMA_BASE_URL?.trim()))
        .map((error) => `${error.provider}: ${error.error}`),
    };
  };
  // Free: a cache hit widens completion and the picker with no request at all. A miss simply means
  // the first `/models` pays for the fetch.
  {
    const cached = await readModelCache(environment);
    if (isCacheFresh(cached)) liveModels = cached!.models;
  }

  /**
   * The input bar's three rows, composed against the screen's live geometry.
   *
   * `status` is whatever the footer should currently be saying — the idle cost line between turns,
   * the spinner's activity line during one. It rides on the box's top border rather than on a row
   * of its own, which is what keeps the chat-style bar to one row more than the plain status line
   * it replaces.
   */
  const promptWidth = () => screen?.current.columns ?? process.stdout.columns ?? 80;

  const promptFrame = (status: string) =>
    renderPromptBox({ mode, workspace: where, depth, width: promptWidth(), status, glyphs, palette });

  /**
   * The inline input bar, for the sessions that do not pin a footer — which is almost all of them,
   * since pinning costs the terminal's scrollback and is therefore off unless asked for.
   *
   * Without this the default session had no bar at all: `showStatus` fell through to a plain status
   * line and the prompt to a bare `archymedes ›`. The chat-app box existed only under `--pin`, which is
   * exactly backwards — the polish was reserved for the configuration almost nobody runs.
   */
  const promptBox = new PromptBox(out, {
    depth,
    glyphs,
    palette: () => palette,
    columns: promptWidth,
  });
  /** True when the inline bar owns the bottom rows: a real TTY that is not holding a region. */
  const inlineBar = (): boolean => ttyMode && screen !== undefined && !screen.pinned;

  /** How wide a status line may be to fit on the bar's top border beside the title. */
  const statusRoomFor = (width: number) => promptStatusRoom(mode, where, width, glyphs);

  /**
   * Repaints the footer with a new status, leaving the input line alone.
   *
   * Both borders are redrawn, not just the top: on a resize the bottom border has moved to a row
   * that previously held transcript, and only the caller of this knows the layout changed.
   */
  const showStatus = (status: string): void => {
    if (screen?.pinned) {
      const frame = promptFrame(status);
      screen.renderStatus(frame.top);
      screen.renderPromptBottom(frame.bottom);
    } else if (inlineBar() && !turnActive) {
      // Between turns the inline bar carries the status on its own top border, so a separate
      // status line would say the same thing twice, one row apart. Mid-turn there is no bar drawn
      // — the activity line is the only status there is — and `statusBar` remains the right home.
      statusBar.clear();
    } else if (ttyMode) statusBar.renderLine(status);
  };

  const showIdleStatus = (): void => showStatus(idleStatusLine());

  /**
   * Jobs whose output is flowing into this session without owning the prompt.
   *
   * A watched job writes into a sink of its own, so it keeps producing while you work on something
   * else, and `/watch show` prints what it has said. That is the difference from `/attach`, which
   * is still here and still the way to *answer* a job — an approval is a question for a person, and
   * a question nobody is looking at is worse than a blocking prompt.
   */
  const watched = new WatchRegistry();

  const startWatching = async (id: string, objective: string): Promise<void> => {
    if (watched.has(id)) { out.write(style.dim(`  already watching ${id}\n`)); return; }
    const sink = new TabSink(sessionStream);
    const stream = new JobStream({
      root: args.root,
      id,
      sink,
      readLog: (root, jobId, fromByte) => readJobLog(root, jobId, fromByte),
      readState: async (root, jobId) => {
        const job = await getJob(root, jobId);
        return job ? { status: job.status, ...(job.pendingApproval ? { pendingApproval: { summary: job.pendingApproval.summary } } : {}) } : undefined;
      },
      format: (line) => `${style.dim(`${id.slice(-6)} ${glyphs.boxVertical}`)} ${line}`,
      onApproval: (summary) => {
        // Written to the session, not to the job's own sink: an approval nobody reads is a job
        // stopped forever, so this is the one thing a background stream is allowed to interrupt with.
        out.write(`  ${style.yellow("approval needed")} ${style.dim(`${glyphs.middot} ${id}`)} ${summary}\n`);
        out.write(`  ${style.dim(`/attach ${id} to answer it`)}\n`);
      },
      onFinished: (status) => {
        out.write(`  ${status === "completed" ? style.green(status) : style.yellow(status)} ${style.dim(`${glyphs.middot} job ${id}`)} ${style.dim(`${glyphs.middot} /watch show ${id}`)}\n`);
      },
    });
    watched.add(id, { stream, sink, objective, startedAt: Date.now() });
    stream.start();
  };

  /** Enqueues a fresh (non-continuation) job and starts its worker — the shared tail of `/jobs run` and `/detach <task>`. */
  const startBackgroundJob = async (objective: string) => {
    // Said every time, because it changes where code executes: a job worker builds its own local
    // workspace and does not inherit this session's sandbox.
    const warning = sandboxWarning(tabs.size > 0 ? tabs.active.payload.backend : args.backend);
    if (warning) out.write(`  ${style.yellow(warning)}\n`);
    const id = newJobId();
    const job = await enqueueJob(args.root, { id, objective, logPath: jobLogPath(args.root, id) });
    await spawnJobWorker(args.root, job.id);
    // Watched from the moment it starts. A job you have to remember to subscribe to is a job whose
    // first minute — the part that usually explains the rest — is the part nobody ever sees.
    await startWatching(job.id, objective);
    return job;
  };

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

  if (args.resume) {
    const indexed = args.resume === "latest" ? await stateHistory.sessions(1) : null;
    const id = args.resume === "latest"
      ? indexed?.[0]?.sessionId ?? (await listSessions(args.root, 1))[0]?.id
      : args.resume;
    const record = id ? await loadSession(args.root, id) : null;
    if (record) {
      // The daemon resumes at construction, not in place — swap the fresh client already opened
      // above for one opened against the resumed record, the same handoff every mode/model switch
      // below performs.
      await agent.relinquish();
      if (record.mode && !args.modeExplicit) mode = record.mode;
      agent = await openClient(record);
      await carryResumedSpend(agent.snapshot());
      out.write(style.dim(`Resumed ${record.id} — ${record.title}\n`));
      // Where the conversation actually got to, not just its id. A resumed session that opens on
      // an empty screen asks the user to trust that a transcript they cannot see is loaded, and
      // the usual next move — scroll back to check — has nothing to scroll to.
      //
      // Only when this run will actually stop at a prompt. A replay is orientation for someone
      // about to type; in front of a one-shot answer it is preamble nobody is waiting for, and
      // `archymedes --resume "…"` from a terminal is still a one-shot even though the terminal is real.
      if (interactive && !args.prompt) out.write(`${renderReplay(agent.snapshot(), sectionStyle(), { turns: 2 })}\n`);
    } else if (args.resume === "latest") {
      out.write(style.yellow("No matching session; starting a new one.\n"));
    } else {
      // An explicit id is a request for *that* conversation. Starting a fresh one instead looks
      // identical for the first few seconds and then diverges silently — the work lands in a new
      // session while the user believes they are adding to the old one. A mistyped id is far
      // cheaper to be told about now.
      process.stderr.write(`${style.red(`No session ${args.resume} in this project.`)} Run archymedes --sessions to list them.\n`);
      await agent.dispose();
      await stateHistory.close();
      exitCleanly();
      return EXIT_CODES.usage;
    }
  }

  // Ctrl-C interrupts the turn rather than the process, so a long tool loop can be stopped
  // without losing the session that produced it.
  let turnActive = false;
  let exitRequested = false;
  const handleSigint = () => {
    if (turnActive) {
      agent.cancel();
      // `agent.cancel()` alone only flips a flag `BoundedAgentRuntime` checks between steps. If
      // this turn is actually blocked inside the approval prompt's `readline.question()` — not a
      // step the runtime loop is between — nothing else would ever unblock it.
      currentTurnAbort?.abort();
      activity.awaitingFirstDelta = false;
      spinner?.stop();
      statusBar.clear();
      const stopping = activity.phase === "operation" ? "stopping the current tool" : "stopping the current model request";
      out.write(style.yellow(`\n  interrupted — ${stopping}\n`));
      return;
    }
    if (pendingReadAbort) {
      pendingReadAbort.abort();
      pendingReadAbort = undefined;
      return;
    }
    // Nothing is running, so this is the prompt. A half-typed message must survive a stray
    // Ctrl+C: every other REPL (bash, python, node) clears the line here rather than quitting,
    // and losing a paragraph you were still composing to one keystroke is the worst possible
    // reading of "I changed my mind". Only an already-empty line means the session itself.
    const pending = (readline as { line?: string }).line ?? "";
    if (pending !== "") {
      // Kill to the start of the line and then to the end, so the line clears whole wherever the
      // cursor happened to sit. Both are ordinary `rl.write(null, key)` calls — the public API —
      // rather than a reach into readline's private redraw internals.
      readline.write(null, { ctrl: true, name: "u" });
      readline.write(null, { ctrl: true, name: "k" });
      return;
    }
    exitRequested = true;
    exitCleanly();
  };
  // Node's readline puts a TTY into raw mode, which disables the kernel's own ISIG handling — so a
  // real Ctrl+C keypress in an interactive session never reaches the process as an OS signal at
  // all; readline reads the byte itself and re-emits it as the *interface's* own "SIGINT" event.
  // `process`'s "SIGINT" only fires for a genuine external signal (`kill -INT`, a piped/non-TTY
  // run). Both are registered so either source reaches the same handler.
  const bindSigint = () => { process.on("SIGINT", handleSigint); readline.on("SIGINT", handleSigint); };
  const unbindSigint = () => { process.off("SIGINT", handleSigint); readline.off("SIGINT", handleSigint); };
  bindSigint();
  exitCleanly = () => { unbindSigint(); watched.stopAll(); screen?.exit(); setWorkspaceMenu(undefined); unbindFixedNavigation(); uninstallShortcuts(); readline.close(); abandonPrompt(); };

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
  /**
   * The runtime's stop reason as the protocol's turn status.
   *
   * They agree on every value but one — the runtime calls a paused approval "needs_approval" — and
   * the suggestion rules speak the protocol's vocabulary, since the desktop reaches them through
   * the same names.
   */
  const failureStatus = (status: AgentRuntimeResult["status"]): NavContext["lastStatus"] =>
    status === "needs_approval" ? "waiting_approval" : status;

  /**
   * Where this session actually is, for anything that has to decide what to offer.
   *
   * Read fresh at every use rather than kept as state: every field here already lives somewhere
   * that owns it — the ledger, the tab controller, the watch registry — and a second copy would be
   * one more thing to keep in step, which is exactly how a "smart" suggestion starts describing a
   * session that ended two turns ago.
   */
  const navContext = (): NavContext => ({
    mode,
    turns: ledger.history.length,
    changedFiles: touchedFiles.size,
    openTodos: agent.todos.filter((item) => item.status !== "done").length,
    runningJobs: watched.size,
    tabs: tabs.size,
    sandbox: agent.workspaceKind !== "local",
    providerConfigured: true,
    hasSpend: Boolean(ledger.displayTotal?.micros),
    ...(lastScanFindings === undefined ? {} : { openFindings: lastScanFindings }),
    ...(ledger.budgetFraction === undefined ? {} : { budgetFraction: ledger.budgetFraction }),
    ...(lastFailure ? { lastStatus: lastFailure.status, lastError: lastFailure.message } : {}),
    recent: usage.recent,
  });
  /**
   * One ambient line, printed where a command had nothing of its own to say.
   *
   * Interactive only, and silent when the rules have nothing left to teach — a session that has
   * already reached for everything relevant gets its empty result back unadorned, which is the
   * point at which a hint would have become a tic.
   */
  const writeHint = (): void => {
    if (!interactive) return;
    const hint = renderHint(navContext(), sectionStyle());
    if (hint) out.write(`${hint}\n`);
  };
  /** Whether the extra model pass is on. A setting, read once, defaulting to off. */
  const suggestModel = (environment.ARCHYMEDES_SUGGEST_MODEL ?? "").trim().toLowerCase() === "on";

  /** Two usages as one, so a turn's cost line covers everything that turn actually spent. */
  const addModelUsage = (left: ModelUsage, right: ModelUsage): ModelUsage => ({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  });

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
          const turn = await model.complete({
            messages: messages.map((message) => ({ role: message.role, content: message.content })),
            tools: [],
            maxOutputTokens,
            safetyIdentifier: agent.sessionId,
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

  let streamedAnswer = false;
  /** The last turn's terminal status, which headless mode turns into the process exit code. */
  let lastTurnStatus: AgentRuntimeResult["status"] = "failed";
  /** The first thing this session was asked to do — the top line of `/task`. */
  let sessionRequest: string | undefined;
  type RecoverableTurn = {
    request: string;
    status: AgentRuntimeResult["status"];
    toolCalls: number;
    changedFiles: number;
  };
  // Kept behind an object because runTurn mutates it from an async closure. TypeScript otherwise
  // narrows a separately-declared nullable variable to its initializer in the outer prompt loop.
  const recoveryState: { last: RecoverableTurn | null } = { last: null };
  /** When the last turn finished, for the pace's cooldown. */
  let lastTurnEndedAt: number | undefined;
  const runTurn = async (request: string): Promise<boolean> => {
    headless?.turnStart(request);
    sessionRequest ??= request; // the opening ask, kept for `/task`
    streamedAnswer = false;
    if (screen) {
      screen.parkInTranscript();
      // The bubble already carries its own "you" label on the box border — a rule printed above
      // it duplicated that label as a second, redundant divider (a leftover from before the two
      // terminal UIs were merged into one). One clearly delimited speaker marker, not two.
      out.write(`${renderUserTurn(request)}\n`);
    }

    // The pace's quiet time, spent before anything is sent. A pause after the *previous* turn is
    // where a person notices the agent misunderstood them; a pause after this one would be too late.
    const cooldown = remainingCooldown(pace, lastTurnEndedAt);
    if (cooldown > 0) {
      const totalCooldown = cooldown;
      const label = (remaining: number, fill: number) =>
        style.dim(`  ${paceBadge(pace, glyphs)} ${glyphs.middot} pausing [${progressBar(fill, 12, { depth: renderDepth, glyphs })}] ${formatCountdown(remaining)} before the next turn`);
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
    if (mode !== "plan" && !await confirmSensitiveTask(readline, interactive, taskSafety, args.allowSensitive)) {
      out.write(style.yellow("  Task cancelled before the model was contacted.\n"));
      return false;
    }
    if (ledger.exhausted) {
      out.write(`${style.red("Budget spent.")} ${ledger.budgetWarning()}\n`);
      return false;
    }
    if (approvedBudget && prices) {
      const spent = ledger.displayTotal?.micros ?? 0;
      const remainingDisplay: Money = { currency: approvedBudget.currency, micros: Math.max(0, approvedBudget.micros - spent) };
      const remainingProvider = convertTo(remainingDisplay, prices.currency, rates);
      if (!remainingProvider) {
        out.write(`${style.red("Cannot continue safely — the approved cap cannot be converted to the provider currency.")}\n`);
        return false;
      }
      agent.setModelSpendLimit(remainingProvider.micros);
    }
    try {
      const prediction = await agent.estimate(request);
      out.write(style.dim(`  ${ledger.formatPrediction(prediction)}\n`));
      const trackedBalance = currentBalance();
      if (trackedBalance && prices) {
        const alert = balanceWatch.observe(trackedBalance, {
          sessionSpend: sessionSpend(),
          sessionTurns: ledger.history.length,
        });
        if (alert) for (const line of alert.lines) out.write(`  ${style.yellow(line)}\n`);
        const low = convertTo(priceUsage({ inputTokens: prediction.inputTokensLow, outputTokens: prediction.outputTokensLow }, prices), trackedBalance.currency, rates);
        const high = convertTo(priceUsage({ inputTokens: prediction.inputTokensHigh, outputTokens: prediction.outputTokensHigh }, prices), trackedBalance.currency, rates);
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
      if (interactive && exceedsPace(pace, prediction)) {
        statusBar.clear();
        const answer = (await readline.question(
          `  ${style.yellow(paceBadge(pace, glyphs))} this turn looks large. Run it? ${style.dim("[Y/n]: ")}`,
        )).trim().toLowerCase();
        if (answer !== "" && answer !== "y" && answer !== "yes") {
          out.write(style.dim("  skipped — nothing was sent to the model\n"));
          return false;
        }
      }
    } catch (error) {
      out.write(style.yellow(`  Could not estimate this turn: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    const started = Date.now();
    beginTranscriptTurn();
    if (ttyMode) {
      activity.awaitingFirstDelta = true;
      const fields = () => ({
        mode,
        spinnerGlyph: spinner!.glyph,
        elapsedMs: Date.now() - started,
        toolCalls: activity.toolCalls,
        tokens: activity.tokens,
        cost: ledger.displayTotal ? formatMoney(ledger.displayTotal) : "cost unknown",
        balance: balanceHeader().compact,
        phase: activity.phase,
        operation: activity.operation,
        // The agent's own plan, counted. Present only once it has one — an X-of-Y with nothing
        // behind it is worse than no counter at all.
        steps: activity.steps,
        badge: paceBadge(pace, glyphs),
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
      const spinnerAccent = () => activeTheme?.name === "rainbow"
        ? colorCode(rainbowHex(Date.now() / 1500), depth)
        : palette.primary;
      const turnSpinner = new Spinner(() => screen?.pinned
        ? showStatus(formatStatusLine(fields(), statusRoomFor(screen.current.columns), depth, glyphs, spinnerAccent()))
        : statusBar.render(fields(), depth, glyphs, spinnerAccent()), 120, glyphs, SPINNER_START_DELAY_MS);
      setSpinner(turnSpinner);
      turnSpinner.start();
    }
    turnActive = true;
    currentTurnAbort = new AbortController();
    // Recorded only once the request is about to contact the model. A task rejected by safety,
    // balance or budget preflight was never attempted and must not become a misleading /retry.
    recoveryState.last = { request, status: "failed", toolCalls: 0, changedFiles: 0 };
    try {
      const spendBeforeTurn = sessionSpend() ?? 0;
      // Durable recall belongs to the shared agent, so CLI, desktop and jobs pay for each selected
      // fact once per thread. Wrapping here as well duplicated it on the first turn and left every
      // other front end without the incremental-deduplication policy.
      const result = await agent.send(request);
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
      if (!streamedAnswer) {
        const label = activity.toolCalls > 0 || touchedFiles.size > 0 ? "summary" : "Archymedes";
        out.write(`\n${rule(sectionStyle(), { label, tone: "accent" })}\n`);
      }
      if (result.status !== "completed" && spokenText && !streamedAnswer && !result.summary.includes(spokenText)) {
        out.write(`\n${asMarkdown(spokenText)}\n`);
      }
      // When the answer streamed, it is already on screen — reprinting it verbatim is noise.
      if (!(result.status === "completed" && streamedAnswer)) {
        out.write(`\n${result.status === "completed" ? asMarkdown(result.summary) : style.yellow(result.summary)}\n`);
      }

      // A finished lab grades every claim it kept, and the grades are the finding. Read from the
      // structured file the lab writes rather than from its prose, and shown only when the run that
      // just ended was a wander — the file lingers in the project afterwards, and reprinting last
      // week's chart under an unrelated turn would be a lie about what just happened.
      if (wanderRunning) {
        wanderRunning = false;
        const graded = await agent.readFile(WANDER_LAB_FILES.results).catch(() => null);
        const chart = graded ? renderWanderResults(graded.content, sectionStyle(), contentWidth()) : null;
        if (chart) out.write(`${chart}\n`);
        const landed = (await Promise.all(wanderArtifacts().map(async (file) => (await agent.readFile(file, { limit: 1 }).catch(() => null)) ? file : null))).filter(Boolean);
        if (landed.length > 0) out.write(style.dim(`  lab files: ${landed.join(", ")}\n`));
      }

      const turn = ledger.record({
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
          cost: turn.cost ? formatMoney(convertTo(turn.cost, display, rates) ?? turn.cost) : "cost unknown",
        }, sectionStyle())}\n`);
      }
      // The hosted exchange returns one routing decision per model call. Keep them for `/route` and
      // show the turn's final one right under the card — the choice this answer was actually run on.
      if (result.routingReceipts && result.routingReceipts.length > 0) {
        out.write(`${renderRoutingReceipt(result.routingReceipts[result.routingReceipts.length - 1], sectionStyle())}\n`);
      }
      if (manualBalance !== undefined) {
        const turnSpend = Math.max(0, (sessionSpend() ?? spendBeforeTurn) - spendBeforeTurn);
        if (turnSpend > 0) {
          const remaining: Balance = { amount: Math.max(0, manualBalance.amount - turnSpend), currency: manualBalance.currency, asOf: Date.now() };
          await persistManualBalance(remaining).catch((error: unknown) => {
            manualBalance = remaining;
            out.write(style.yellow(`  Balance was updated for this session but could not be saved: ${error instanceof Error ? error.message : String(error)}\n`));
          });
        }
      }
      // The turn's own closing rule. A transcript without one is a single column in which the end
      // of an answer and the start of the next question look identical.
      out.write(`${rule(sectionStyle(), {
        label: result.status,
        tone: result.status === "completed" ? "good" : "warn",
        trailing: ledger.formatTurn(turn),
      })}\n`);
      const warning = ledger.budgetWarning();
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
      if (!cacheChurnReported && ledger.cacheHealth.churning) {
        cacheChurnReported = true;
        out.write(`  ${style.yellow(CACHE_CHURN_HINT)}\n`);
      }
      // A turn ending is the one moment a person is deciding what to do next, so this is where the
      // suggestions go: what the situation calls for, with the reason attached, plus — only when
      // the situation was quiet enough to leave room — one thing about Archymedes worth knowing.
      // Suppressed once they have used it: a hint you have taken is not a hint.
      lastFailure = result.status === "completed" ? null : { status: failureStatus(result.status), message: result.summary };
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
      lastTurnStatus = result.status;
      headless?.turnEnd({
        status: result.status,
        summary: result.summary,
        iterations: result.iterations,
        toolCalls: result.toolCallsExecuted,
        usage: result.usage,
        cost: ledger.displayTotal ? formatMoney(ledger.displayTotal) : null,
        elapsedMs: Date.now() - started,
      });
      refreshProjectFiles(); // a turn can create files, and the next mention should complete them
    } catch (error) {
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
        out.write(`\n${style.yellow(`Stopped at the ${formatMoney(fromUnits(args.budget, display))} cap for this request.`)}\n`);
        out.write(style.dim(`  Raise it with --budget, or ask for something smaller.\n`));
        lastTurnStatus = "iteration_limit";
        lastFailure = { status: "iteration_limit", message };
        const recovery = renderRecovery(navContext(), sectionStyle());
        if (recovery && interactive) out.write(`${recovery}\n`);
        headless?.error(`Stopped at the approved cap for this request.`, { status: "iteration_limit" });
        return false;
      }
      // A raw transport error ("fetch failed", "getaddrinfo ENOTFOUND …") reads as "the internet
      // is broken", which is usually wrong — it is one endpoint failing. Name the host, the
      // failure class, and the next step; anything that is not a network fault prints as before.
      const diagnosis = classifyNetworkError(error, {
        host: hostOf(providerBaseUrl(environment, spec.id)),
        purpose: `the model API (${spec.label})`,
      });
      if (diagnosis) {
        out.write(`${style.red("error")} ${diagnosis.message}\n`);
        if (diagnosis.hint) out.write(`  ${style.dim(diagnosis.hint)}\n`);
      } else {
        out.write(`${style.red("error")} ${message}\n`);
      }
      const fallback = parseFallbackPreference(environment.ARCHYMEDES_FALLBACK_MODEL);
      const transient = diagnosis && ["timeout", "dns", "refused", "reset", "unreachable", "rate_limit", "server_error"].includes(diagnosis.kind);
      // Cross-provider retry is safe only before visible output, tool execution, or file changes.
      // A specific target is explicit consent; `ask` merely offers the choice and never spends.
      if (interactive && transient && !streamedAnswer && activity.toolCalls === 0 && touchedFiles.size === 0 && fallback?.kind === "target") {
        const attempt = resolveProvider(environment, { provider: fallback.provider, model: fallback.model });
        if (!("error" in attempt) && (attempt.spec.id !== spec.id || attempt.model !== resolvedModelId)) {
          const previous = agent;
          const carried = await previous.relinquish();
          model = attempt.provider;
          spec = attempt.spec;
          prices = attempt.prices;
          resolvedModelId = attempt.model;
          ledger.setPrices(prices);
          agent = await openClient(carried);
          queuedInput.unshift("/retry");
          out.write(style.yellow(`  falling back once to ${spec.label} ${resolvedModelId}; the unchanged request is queued for retry\n`));
        }
      } else if (interactive && transient && fallback?.kind === "ask") {
        out.write(style.dim("  fallback is set to ask — use /model to choose an alternate, then /retry\n"));
      }
      // An error says what broke; this says what to do about it. The rules only speak when they
      // recognise the failure — an invented next step after a real error costs a detour to
      // discover it was a guess, which is worse than the silence it replaced.
      lastFailure = { status: "failed", message };
      const recovery = renderRecovery(navContext(), sectionStyle());
      if (recovery && interactive) out.write(`${recovery}\n`);
      lastTurnStatus = "failed";
      headless?.error(message, { status: "failed" });
      return false;
    } finally {
      turnActive = false;
      currentTurnAbort = undefined;
      lastTurnEndedAt = Date.now();
    }
    return true;
  };

  if (args.prompt) {
    if (args.prompt.trimStart().startsWith("/")) {
      // A one-shot argument is an objective, not an interactive input queue. Sending a slash
      // command to the model is the costly failure mode: it spends tokens trying to interpret a
      // local control it can never execute. Fail before estimation or provider contact instead.
      process.stderr.write(`Slash commands run inside an interactive Archymedes session. Start archymedes, then type ${args.prompt.trim()}.\n`);
      await agent.dispose();
      await stateHistory.close();
      exitCleanly();
      return EXIT_CODES.usage;
    }
    // Announced before any work, so a consumer knows what it is reading before the first event.
    headless?.session({
      sessionId: agent.sessionId,
      root: args.root,
      provider: spec.id,
      model: resolvedModelId,
      mode,
      workspace: agent.workspaceLabel,
    });
    const ran = await runTurn(args.prompt);
    // A one-shot run against a sandbox would otherwise leave the work unreachable, so it is
    // offered back before the sandbox goes away.
    if (ran && workspace.kind === "e2b") {
      const destination = path.resolve(args.root, "archymedes-pull");
      const pulled = await downloadProject(workspace, destination);
      out.write(style.dim(`  pulled ${pulled.written.length} files into ${destination}\n`));
    }
    await agent.dispose();
    await stateHistory.close();
    exitCleanly();
    // Headless callers get the specific outcome; the human path keeps its long-standing 0/1.
    return args.json ? exitCodeForStatus(lastTurnStatus) : (ran ? 0 : 1);
  }

  const where = workspace.kind === "e2b" ? `sandbox ${workspace.label.split(":")[1]}` : path.basename(args.root);
  const identityMotion = new AbortController();
  const stopIdentityMotion = () => identityMotion.abort();
  if (ttyMode) process.stdin.on("data", stopIdentityMotion);
  try {
    await writeIdentity({
      width: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      version: ARCHYMEDES_CLI_VERSION,
      workspace: where,
      model: `${spec.label} ${resolvedModelId}`,
      mode,
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
  // One dim context line under the identity rather than a stack of them: the benchmark, the
  // currency costs are shown in, and any standing session modifiers (pace, remembered facts). The
  // yellow lines below are the ones that ask for a decision, so those keep their own rows.
  const context = [
    renderReliabilityStatus(999, glyphs.middot),
    `costs ${display}${preference.countryCode ? ` ${glyphs.middot} location ${preference.countryCode}` : ""} (${preference.source === "location" ? "auto-detected" : preference.source})`,
  ];
  if (pace !== "off") context.push(`${paceBadge(pace, glyphs)} ${glyphs.middot} /slow off to lift`);
  if (memories.length > 0) context.push(`${memories.length} remembered fact${memories.length === 1 ? "" : "s"} ${glyphs.middot} /memory`);
  out.write(`${style.dim(`  ${context.join(`  ${glyphs.middot}  `)}`)}\n`);
  if (localCurrencyWarning) out.write(`${style.yellow(`  ${localCurrencyWarning}`)}\n`);
  if (!args.budget) {
    out.write(`${style.yellow(`  No session spend cap set ${glyphs.middot} use --budget N to approve and enforce one.`)}\n`);
    // Named beside the cap it is not: someone reading that line is thinking about spending, and
    // this is the other half of the answer.
    if (pace === "off") out.write(style.dim(`  ${glyphs.middot} /slow paces spending without capping it\n`));
  }
  if (!prices) {
    out.write(`${style.yellow(`  No price configured for ${resolvedModelId} ${glyphs.middot} costs will show as unknown.`)}\n`);
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

  /**
   * The footer goes up after the banner, not before — the banner is the top of the transcript, not
   * chrome that belongs pinned. Only for a real interactive TTY: a one-shot `--prompt` run, a pipe,
   * or `--estimate` prints a few lines and exits, where a scroll region would be pure overhead with
   * nothing to keep separately scrolled from before it is torn down again a moment later.
   */
  // `ARCHYMEDES_PIN` exists so the choice can live in a shell profile rather than in every invocation.
  const pinFooter = wantsPinnedFooter(args.pin, environment);
  const setLayout = (fixed: boolean) => {
    screen?.exit();
    setWorkspaceMenu(undefined);
    const next = fixed ? new WorkspaceFrame(process.stdout,
      () => ({ version: ARCHYMEDES_CLI_VERSION, workspace: path.basename(args.root), model: `${spec.label} / ${resolvedModelId}`, mode, palette, glyphs, busy: turnActive }),
      () => tabs.active.payload.sink.log, workspaceFrameOptions(environment, process.stdin))
      : new PinnedScreen(process.stdout, { holdRegion: pinFooter });
    setScreen(next);
    next.enter();
    if (next instanceof WorkspaceFrame) setWorkspaceMenu(next.menu);
    showIdleStatus();
  };
  if (ttyMode) {
    // Always constructed, because the suggestion dropdown needs its geometry either way; only the
    // *holding* of the scroll region — the part that costs scrollback — is what `--pin` buys.
    setLayout(resolveLayout(args, environment) === "fixed");
    const fixedNavigation = (_str: string, key: ScrollKey | undefined) => {
      if (!(screen instanceof WorkspaceFrame)) return;
      screen.stopIntroMotion();
      const action = transcriptScrollForKey(key, screen.browsing);
      if (action) screen.scroll(action);
    };
    unbindFixedNavigation = () => { process.stdin.off("keypress", fixedNavigation); };
    bindFixedNavigation = () => { unbindFixedNavigation(); process.stdin.on("keypress", fixedNavigation); };
    bindFixedNavigation();
    process.stdout.on("resize", () => {
      screen?.resize();
      showIdleStatus();
      if (screen instanceof WorkspaceFrame && !turnActive) {
        screen.positionInput();
        readline.prompt(true);
        showIdleStatus();
      }
    });

    /**
     * True navigation for the dropdown: borrows the keyboard exactly the way the full palette and
     * model picker already do (`withBorrowedKeyboard`), so Up/Down move a real highlighted
     * selection instead of falling through to readline's own history navigation — which is what
     * used to happen, since two independent listeners both saw the same keystroke with no way for
     * one to tell the other "I've got this one".
     *
     * Deliberately does not accept typed characters while browsing (`filter: false`): the line
     * itself is never touched here, so there is nothing to reconcile afterward. Escape, or any key
     * that is not a navigation key, ends browsing with `rl.line` exactly as the user left it —
     * pressing a letter to keep narrowing "exits browse mode and that key still lands", not "gets
     * eaten". Accepting a row submits it through the *pending* `question()` via `rl.write`, the
     * same public API a real Enter keypress would drive — nothing here reaches into readline's
     * private state.
     */
    const browseSuggestions = async (line: string, suggestions: readonly { command: string; args?: string; description: string }[]): Promise<void> => {
      if (!screen) return;
      // A model-argument suggestion's own `command` is the bare model id ("claude-sonnet-5"), not
      // a runnable line — reattach whatever prefix was actually typed ("/model ") so accepting one
      // submits the full command, not the id alone read as a chat message.
      const modelPrefix = /^\/models?\s+/.exec(line)?.[0];
      const items: ChooserItem<string>[] = suggestions.map((entry) => ({
        value: modelPrefix ? `${modelPrefix}${entry.command}` : entry.command,
        label: entry.args ? `${entry.command} ${entry.args}` : entry.command,
        description: entry.description,
      }));
      const host = { readline, input: process.stdin, output: process.stdout };
      const chosen = inlineBar()
        ? await browseDropup(host, items.map((item) => item.value), suggestions)
        : await withBorrowedKeyboard(host, undefined, (keys, paint) => runChooser(keys, items, paint, {
          width: process.stdout.columns ?? 80,
          height: items.length,
          filter: false,
          paint: { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow },
          glyphs,
        }), { paint: (frame: string) => screen?.renderSuggestions(frame.split("\n")), erase: () => screen?.clearSuggestions() });
      if (!chosen) return;
      // The accepted row is a *whole* line, not a completion of the partial one: it already carries
      // its leading "/" and, for a model argument, the "/model " prefix that was typed. Writing it
      // onto a line that still holds "/a" submits "/a/auto" — the reported "//auto" is just this
      // with a one-character prefix. `replaceLine` is the same line-clearing a bound shortcut does
      // before submitting, and it is shared rather than repeated so both agree about the cursor.
      replaceLine(rl, chosen);
      rl.write("\n");
    };

    /**
     * Arrow-key selection inside the dropup the user is already looking at.
     *
     * Deliberately not `runChooser`. The chooser renders best-match-first top-down, which is right
     * for a menu that opens downward and wrong here: the dropup deliberately puts its best match on
     * the *bottom* row, against the prompt. Handing the chooser these rows would flip the list the
     * moment an arrow key was pressed, so the row under the user's eye when they reached for Up is
     * not the row that ends up selected. Repainting through `showDropup` instead means browsing and
     * reading are the same list, in the same order, with a cursor added.
     *
     * The direction mapping follows from that reversal and is not a bug: Up moves *up the screen*,
     * which is away from the prompt and therefore toward later entries in rank order.
     */
    const browseDropup = async (
      host: { readline: typeof readline; input: NodeJS.ReadStream; output: NodeJS.WriteStream },
      values: readonly string[],
      suggestions: readonly { command: string; args?: string; description: string }[],
    ): Promise<string | undefined> => withBorrowedKeyboard(host, undefined, async (keyStream) => {
      let selected = 0;
      showDropup(suggestions, selected);
      for await (const { key } of keyStream) {
        const name = key.name;
        if (name === "escape" || (key.ctrl && name === "c")) return undefined;
        if (name === "return" || name === "enter" || name === "tab") return values[selected];
        if (name === "up") selected = Math.min(values.length - 1, selected + 1);
        else if (name === "down") selected = Math.max(0, selected - 1);
        // Any other key ends browsing without eating the keystroke's meaning: the user has gone back
        // to typing, and the list becomes something they are reading again rather than driving.
        else return undefined;
        showDropup(suggestions, selected);
      }
      return undefined;
    }, { paint: () => undefined, erase: () => clearDropup() });
    let browsing = false;

    /**
     * Hands a set of rows to the prompt box and repairs whatever moving the bar disturbed.
     *
     * The repair sequence is the fiddly part, and its order is forced rather than chosen. When the
     * row count changes the box erases its whole block — the input row included — so:
     *
     * 1. `readline.prompt(true)` redraws the prompt prefix and the typed line, restoring the row the
     *    user is actually editing. It must come first, because readline's own refresh ends with an
     *    `ED 0` that would wipe anything already drawn below the input row.
     * 2. Only then is the closing border redrawn, into the row that `ED 0` just cleared.
     *
     * Doing these the other way round draws a border and immediately erases it, which reads as the
     * bar losing its bottom edge at random — the exact symptom `dropBorder` was written for, arriving
     * from a second direction.
     */
    const applyDropup = (lines: readonly string[]): void => {
      const status = idleStatusLine();
      const { moved } = promptBox.setSuggestions(lines, { mode, workspace: where, status });
      if (!moved) return;
      readline.prompt(true);
      promptBox.restoreBottomBorder(mode, where, status);
    };

    const clearDropup = (): void => { if (promptBox.suggestionRows > 0) applyDropup([]); };

    const showDropup = (suggestions: readonly { command: string; args?: string; description: string }[], selected?: number): void => {
      const columns = process.stdout.columns ?? 80;
      const entries: DropupEntry[] = suggestions.map((entry) => ({
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        description: entry.description,
        ...(chordFor.get(entry.command) ? { chord: chordFor.get(entry.command)! } : {}),
      }));
      applyDropup(renderDropup(entries, {
        width: columns,
        maxRows: dropupRowBudget(process.stdout.rows ?? 24, entries.length),
        ...(selected === undefined ? {} : { selected }),
        glyphs,
        paint: { dim: style.dim, cyan: style.cyan, green: style.green },
      }));
    };

    /**
     * The suggestion dropdown, repainted from whatever is on the line.
     *
     * Driven off keypresses rather than off a wrapper around input, because readline owns the line
     * and this must not: the buffer is read after each key and never written to. `setImmediate`
     * defers to readline's own handler, which is registered first — reading `line` synchronously
     * would see the state from before the keystroke and leave the list one character stale.
     */
    /**
     * Whether the inline dropup can safely draw right now.
     *
     * The list is painted with cursor motions measured *from the input row*, so it is correct only
     * while the cursor is actually on that row. A line long enough to wrap has pushed the cursor
     * down onto the closing border, and every upward count would then land one row short and
     * overwrite the bar instead of the list. Suggestions only ever appear for a single `/word`, so
     * this refuses in a case that essentially cannot arise — on a terminal narrow enough to wrap a
     * command name, the honest answer is no list rather than a corrupted bar.
     */
    const dropupSafe = (line: string): boolean =>
      promptBox.isDrawn && PROMPT_PREFIX_COLUMNS + visibleWidth(line) < (process.stdout.columns ?? 80);

    /** The chord label to show beside a suggested command, so the list teaches its own shortcuts. */
    const chordFor = keys.shortcutLabels();

    /**
     * The suggestion list, repainted from whatever is on the line.
     *
     * Driven off keypresses rather than off a wrapper around input, because readline owns the line
     * and this must not: the buffer is read after each key and never written to. `setImmediate`
     * defers to readline's own handler, which is registered first — reading `line` synchronously
     * would see the state from before the keystroke and leave the list one character stale.
     *
     * Two renderers, one per bar. A pinned footer has reserved rows and `PinnedScreen` addresses
     * them absolutely, which is correct *because* the region holds the bar on a known row. The
     * inline bar has no such row, so it uses the dropup, which measures upward from the cursor and
     * therefore finds the bar wherever the transcript has left it. That relative measurement is the
     * whole fix: the old code simply declined to draw anything inline, which is why the default
     * session — nearly every session, since pinning costs scrollback — had ghost text and no list.
     */
    const paintSuggestions = (_str: string | undefined, key: ScrollKey | undefined) => setImmediate(() => {
      if (turnActive || browsing || isTranscriptKey(key)) return;
      const line = (readline as { line?: string }).line ?? "";
      const suggestions = suggestionsFor(line, buildModelCatalog(environment, undefined, liveModels).choices.map((choice) => choice.model));

      if (inlineBar()) {
        if (suggestions.length === 0 || !dropupSafe(line)) { clearDropup(); return; }
        if (key?.name === "up" || key?.name === "down") {
          browsing = true;
          browseSuggestions(line, suggestions).catch(() => undefined).finally(() => { browsing = false; });
          return;
        }
        showDropup(suggestions);
        return;
      }

      if (suggestions.length === 0) { screen?.clearSuggestions(); return; }
      if (key?.name === "up" || key?.name === "down") {
        browsing = true;
        // Errors here must not become an unhandled rejection that takes the process down mid-turn
        // over what is, worst case, a dropdown that failed to open — the keyboard would already
        // have been restored by `withBorrowedKeyboard`'s own `finally`, so falling back to the
        // ordinary passive dropdown next keystroke is a full recovery, not a degraded state.
        browseSuggestions(line, suggestions).catch(() => undefined).finally(() => { browsing = false; });
        return;
      }
      const width = Math.max(...suggestions.map((entry) => entry.command.length + (entry.args ? entry.args.length + 1 : 0)));
      screen?.renderSuggestions(suggestions.map((entry) => {
        const head = entry.args ? `${entry.command} ${entry.args}` : entry.command;
        return `  ${style.cyan(head.padEnd(width + 2))}${style.dim(entry.description)}`;
      }));
    });
    /**
     * The greyed-out rest of the command, painted after the cursor as you type.
     *
     * What replaces the dropdown for the inline bar. It writes *after* the cursor and puts the
     * cursor straight back, so readline's idea of where it is never changes and the row count never
     * changes either — the two things that made the reserved-row dropdown unsafe here.
     *
     * Erasing to end of line first is what keeps a shrinking suggestion from leaving its own tail
     * behind (`/mode` back to `/mod` would otherwise strand the old `l`). Anything still on screen
     * at submit is wiped by `promptBox.erase`, which already clears these rows whole.
     */
    const paintGhost = () => setImmediate(() => {
      if (turnActive || browsing || !promptBox.isDrawn) return;
      const line = (readline as { line?: string }).line ?? "";
      const cursor = (readline as { cursor?: number }).cursor ?? line.length;
      // Only at the end of the line: a completion offered from the middle would be describing text
      // the cursor is not actually about to extend.
      if (cursor !== line.length) { out.write("\x1b7\x1b[K\x1b8"); return; }
      const { suffix, alternatives } = inlineCompletion(line, buildModelCatalog(environment, undefined, liveModels).choices.map((choice) => choice.model));
      const hint = suffix === "" ? "" : `${style.dim(suffix)}${alternatives > 0 ? style.dim(`  +${alternatives}`) : ""}`;
      out.write(`\x1b7\x1b[K${hint}\x1b8`);
    });

    /** Right arrow at the end of the line takes the offer, the way fish and every browser bar do. */
    const acceptGhost = (_str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
      if (!key || key.name !== "right" || key.ctrl || key.meta) return;
      if (turnActive || browsing || !promptBox.isDrawn) return;
      const line = (readline as { line?: string }).line ?? "";
      const cursor = (readline as { cursor?: number }).cursor ?? 0;
      if (cursor !== line.length) return; // mid-line, the arrow means "move right"
      const { suffix } = inlineCompletion(line, buildModelCatalog(environment, undefined, liveModels).choices.map((choice) => choice.model));
      if (suffix !== "") readline.write(suffix);
    };

    process.stdin.on("keypress", paintSuggestions);
    process.stdin.on("keypress", paintGhost);
    process.stdin.on("keypress", acceptGhost);
  }

  /**
   * Re-reads the display currency from settings, and makes the session actually use it.
   *
   * Setting your location is only worth doing if the next number you read is in your money. The
   * preference is resolved once at startup, so without this a location saved in `/settings` would
   * be correct in the file, correct on the next launch, and invisible for the rest of the session
   * the user changed it in — which reads as the setting not working.
   *
   * A command-line `--currency` still wins: it is this run's explicit instruction, and a saved
   * preference should not quietly override what was typed to start the process.
   */
  const applyCurrencyPreference = async (): Promise<void> => {
    const next = resolveCurrencyPreference({ currency: args.currency, country: args.country, environment, providerCurrency: prices?.currency ?? "USD" });
    if (next.currency === display) return;

    if (prices && next.currency !== prices.currency) {
      const convertible = () => rates.some((rate) => (rate.from === prices!.currency && rate.to === next.currency) || (rate.to === prices!.currency && rate.from === next.currency));
      if (!convertible() && environment.ARCHYMEDES_FX_OFFLINE !== "true") {
        const daily = await fetchDailyFxRate(prices.currency, next.currency);
        if (daily) rates.push(daily);
      }
      // Refusing to switch beats switching to a currency every future cost then fails to convert
      // into — the session would keep working while reporting nothing.
      if (!convertible()) {
        out.write(style.yellow(`  No ${prices.currency}→${next.currency} rate is available, so costs stay in ${display}.\n`));
        return;
      }
    }
    display = next.currency;
    ledger.setDisplay(display, rates);
    for (const tab of tabs.all) tab.payload.ledger.setDisplay(display, rates);
    out.write(style.dim(`  costs now shown in ${display}${next.countryCode ? ` · location ${next.countryCode}` : ""}\n`));
  };

  /**
   * The settings menu, and everything that has to happen once it closes.
   *
   * A function rather than an inline block because `/settings` is no longer the only way in: the
   * model picker's "add a key" row opens the same flow, and a second copy would be a second place
   * for "reload the environment and rebuild the client" to be got wrong.
   */
  const openSettings = async (): Promise<"saved" | "cancelled" | "exit"> => {
    let nextSettings: ArchymedesSettings;
    try {
      nextSettings = await runSettingsMenu(savedSettings, {
        ask: (question) => readline.question(question),
        askSecret: (question) => hiddenQuestion(readline, question),
        write: (text) => out.write(text),
        ...(interactive ? { choose: settingsChooser(readline) } : {}),
      }, {
        // Prices in the currency this session is already reporting in, rather than the provider's.
        modelChoices: (field, current) => modelChoicesForSettingsField(field, current, processEnvironment, display, rates),
      });
    } catch (error) {
      if (!isReadlineExit(error)) throw error;
      out.write(style.dim("\n  settings cancelled — no changes were saved\n"));
      return exitRequested ? "exit" : "cancelled";
    }
    savedSettings = nextSettings;
    const file = await saveSettings(savedSettings, processEnvironment);
    for (const field of SETTING_FIELDS) delete environment[field.key];
    Object.assign(environment, mergedEnvironment(savedSettings, processEnvironment));
    manualBalance = parseManualBalance(environment.ARCHYMEDES_ACCOUNT_BALANCE, environment.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY);
    language = resolveControlLanguage(args.language ?? environment.ARCHYMEDES_LANGUAGE ?? environment.LANG);
    const previous = agent;
    const carried = await previous.relinquish();
    agent = await openClient(carried);
    out.write(style.green(`  settings saved to ${file}\n`));
    await applyCurrencyPreference();
    out.write(style.dim(`  Settings are active now${environment.EXA_API_KEY?.trim() ? "; Exa web_search is available" : ""}. Use /model only to change the selected model.\n`));
    return "saved";
  };

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

  /**
   * One update round, before the first prompt and never again in this session.
   *
   * Here rather than on a timer, because this is the only moment that is unambiguously safe: no
   * turn is running, no job is attached, and nothing is half-written to the screen. The check
   * itself is bounded at three seconds, and every reason not to act — a pipe, CI, a session that
   * already looked today — is decided before the network is touched at all.
   */
  const startupBalance: Promise<Balance | undefined> = Promise.resolve(currentBalance());
  // Knowledge replication is independent of package updates and model calls. It is deliberately
  // detached: an offline feed must add zero startup latency, and the last verified/bundled corpus
  // remains usable while this attempt completes in the background.
  void updateDefenderFeed(environment).catch(() => undefined);
  const startupUpdatePromise = runAutoUpdate({
    context: {
      mode: readAutoUpdateMode(environment),
      interactive: interactive && liveTerminal,
      environment,
      currentVersion: ARCHYMEDES_CLI_VERSION,
    },
    fetchLatest: (timeoutMs) => fetchLatestVersion({ environment, timeoutMs }),
    install: async (version) => {
      const result = await runSelfUpdate({
        yes: true,
        interactive: false,
        environment,
        // Silent unless it has something to say: the outcome is reported through the notice below,
        // and a package manager's own progress output has no business interrupting a prompt.
        stdout: () => {},
        stderr: () => {},
      });
      return result.status === "updated" && result.latestVersion === version;
    },
  }).catch(() => {
    // An update check must never be the reason a session fails to start.
    return undefined;
  });
  const [startupUpdate] = await Promise.all([startupUpdatePromise, startupBalance]);
  for (const line of startupUpdate?.notice ?? []) out.write(`  ${style.dim(line)}\n`);

  for (;;) {
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
    let input = rawInput.trim();
    if (!input) continue;

    const layoutCommand = parseLayoutCommand(input, screen instanceof WorkspaceFrame ? "fixed" : "scrollback");
    if (layoutCommand) {
      if (!ttyMode) out.write("  Fixed layout requires an interactive terminal.\n");
      else if ("error" in layoutCommand) out.write(layoutCommand.error);
      else { setLayout(layoutCommand.layout === "fixed"); out.write(style.dim(layoutNotice(layoutCommand.layout))); }
      continue;
    }

    usage.record(input);

    // The palette resolves to a command and then falls through to the same dispatch a typed one
    // takes. Anything else would be a second place for a command's behaviour to live.
    if (input === "/palette") {
      const chosen = interactive
        ? await openPalette({ readline, input: process.stdin, output: process.stdout, registry: keys }, undefined, {
            // Ranked against this session: the empty-query view is otherwise the catalog in
            // alphabetical order, which is the least useful thing a palette can open on.
            rank: (entries, query) => rankWithContext(entries, query, navContext()),
          })
        : undefined;
      if (!chosen?.trim()) continue;
      input = chosen.trim();
    }

    if (input === "/exit" || input === "/quit") break;
    if (input === "/help" || input.startsWith("/help ")) {
      // Grouped and filtered to what this session can actually use, with everything one keystroke
      // away. The flag reference stays on `archymedes --help`, where someone reading about invocation is
      // looking; inside a session it is thirty lines about starting a session you are already in.
      const requested = input.slice("/help".length).trim();
      const groupNames = ["work", "review", "steer", "parallel", "learn", "setup"] as const;
      if (requested && requested !== "all" && !groupNames.includes(requested as typeof groupNames[number])) {
        out.write(style.yellow("  Choose /help all, work, review, steer, parallel, learn, or setup.\n"));
        continue;
      }
      out.write(`${renderGroupedHelp(navContext(), sectionStyle(), {
        all: requested === "all" || Boolean(requested),
        ...(requested && requested !== "all" ? { group: requested as typeof groupNames[number] } : {}),
      })}\n`);
      continue;
    }
    if (input === "/retry") {
      const lastRecoverableTurn = recoveryState.last;
      if (!lastRecoverableTurn) {
        out.write(style.dim("  nothing to retry — no model request has failed in this session\n"));
        continue;
      }
      if (lastRecoverableTurn.status === "completed") {
        out.write(style.dim("  the last task completed — describe a new request, or use /continue only after an incomplete task\n"));
        continue;
      }
      if (lastRecoverableTurn.toolCalls > 0 || lastRecoverableTurn.changedFiles > 0) {
        out.write(style.yellow(`  retry refused — the last task already ran ${lastRecoverableTurn.toolCalls} tool${lastRecoverableTurn.toolCalls === 1 ? "" : "s"} and changed ${lastRecoverableTurn.changedFiles} file${lastRecoverableTurn.changedFiles === 1 ? "" : "s"}.\n`));
        out.write(style.dim("  Use /continue to inspect the current state and finish without repeating completed actions.\n"));
        continue;
      }
      out.write(style.dim("  retrying the unchanged request — no earlier tool or file action can be duplicated\n"));
      input = lastRecoverableTurn.request;
    }
    if (input === "/continue") {
      const lastRecoverableTurn = recoveryState.last;
      if (!lastRecoverableTurn) {
        out.write(style.dim("  nothing to continue — start a task first\n"));
        continue;
      }
      if (lastRecoverableTurn.status === "completed") {
        out.write(style.dim("  the last task is already complete\n"));
        continue;
      }
      out.write(style.dim(`  continuing from the current state ${glyphs.middot} ${lastRecoverableTurn.toolCalls} tools already ran ${glyphs.middot} ${lastRecoverableTurn.changedFiles} files changed\n`));
      input = "Continue the previous task from the current workspace and conversation. Inspect what already completed before acting, do not repeat successful side effects, finish the remaining work, and run the relevant verification.";
    }
    if (input === "/fallback" || input.startsWith("/fallback ")) {
      const raw = input.slice("/fallback".length).trim();
      if (!raw) {
        const current = parseFallbackPreference(environment.ARCHYMEDES_FALLBACK_MODEL) ?? { kind: "off" as const };
        const label = current.kind === "target" ? `${current.provider}:${current.model}` : current.kind;
        out.write(style.dim(`  provider fallback: ${label}\n`));
        continue;
      }
      const preference = parseFallbackPreference(raw);
      if (!preference) {
        out.write(style.yellow(`  Choose /fallback off, /fallback ask, or /fallback provider:model (providers: ${FALLBACK_PROVIDERS.join(", ")}).\n`));
        continue;
      }
      const value = fallbackSetting(preference);
      savedSettings = { ...savedSettings };
      if (value) savedSettings.ARCHYMEDES_FALLBACK_MODEL = value;
      else delete savedSettings.ARCHYMEDES_FALLBACK_MODEL;
      try {
        await saveSettings(savedSettings, processEnvironment);
        if (value) environment.ARCHYMEDES_FALLBACK_MODEL = value;
        else delete environment.ARCHYMEDES_FALLBACK_MODEL;
        out.write(style.dim(`  provider fallback ${preference.kind === "off" ? "disabled" : `set to ${value}`} · saved\n`));
      } catch (error) {
        out.write(style.yellow(`  Could not save fallback setting: ${error instanceof Error ? error.message : String(error)}\n`));
      }
      continue;
    }
    if (input === "/export" || input.startsWith("/export ")) {
      const format = (input.slice("/export".length).trim() || "markdown") as ExportFormat;
      if (!["markdown", "json", "support"].includes(format)) {
        out.write(style.yellow("  Choose /export markdown, /export json, or /export support.\n"));
        continue;
      }
      const record = await loadSession(args.root, agent.sessionId);
      if (!record) {
        out.write(style.yellow("  This session has not produced a saved turn yet.\n"));
        continue;
      }
      try {
        const file = await exportSession(record, format);
        out.write(style.dim(`  redacted ${format} export written to ${file}\n`));
      } catch (error) {
        out.write(style.yellow(`  Could not export the session: ${error instanceof Error ? error.message : String(error)}\n`));
      }
      continue;
    }
    if (input === "/mode" && screen instanceof WorkspaceFrame) {
      const modes = ["plan", "build", "auto", "defender"] as const;
      const descriptions = ["Read and reason; no changes", "Edit with your approval", "Apply ordinary changes automatically", "Security review; fixes require approval"];
      const chosen = await openChooser({ readline, input: process.stdin, output: process.stdout },
        modes.map((value, i) => ({ value, label: value, description: descriptions[i], hint: value === mode ? "current" : undefined })),
        { title: "Choose how Archymedes works", initialIndex: modes.indexOf(mode), paint: surfacePaint, glyphs });
      if (!chosen) continue;
      input = `/mode ${chosen}`;
    }
    const modeCommand = parseModeCommand(input);
    if (modeCommand?.type === "show") {
      const posture = mode === "plan" ? "read-only; write and command tools are unavailable" : mode === "build" ? "workspace changes ask for approval" : mode === "defender" ? "security review; every change still asks for approval" : "ordinary workspace changes are pre-approved; sensitive and external actions still ask";
      out.write(`  ${style.cyan(mode)} · ${style.dim(posture)}\n`);
      continue;
    }
    if (modeCommand?.type === "invalid") {
      out.write(style.yellow("  Choose /mode plan, /mode build, /mode auto, or /mode defender.\n"));
      continue;
    }
    if (modeCommand?.type === "switch") {
      const requestedMode: ArchymedesMode = modeCommand.mode;
      if (requestedMode === mode) {
        out.write(style.dim(`  already in ${mode} mode\n`));
        continue;
      }
      mode = requestedMode;
      // A new mode is a new permission posture; the transcript carries over so the plan the agent
      // just produced is still in context when it starts building — Cline's behaviour, and the
      // reason Plan mode is useful rather than a separate conversation.
      const previous = agent;
      // Relinquishing returns the live transcript atomically, before retiring the old client.
      const carried = await previous.relinquish();
      agent = await openClient(carried);
      const posture = mode === "plan" ? "read-only; no write tools" : mode === "build" ? "edits and commands require approval" : mode === "defender" ? "security review; every fix still requires approval" : "ordinary edits and commands are pre-approved; sensitive and external actions require approval";
      out.write(style.dim(`  switched to ${mode} mode · ${posture}\n`));
      continue;
    }
    const modelCommand = parseModelCommand(input);
    if (modelCommand) {
      const target = await chooseModel(modelCommand, {
        environment,
        liveModels: () => liveModels,
        refreshLiveModels,
        current: { provider: spec.id, model: resolvedModelId },
        display,
        rates,
        ...(interactive ? { host: { readline, input: process.stdin, output: process.stdout } } : {}),
        write: (text) => out.write(text),
        paint: { ...surfacePaint, yellow: style.yellow, dim: style.dim },
        glyphs,
        width: contentWidth(),
      });
      if (target.kind === "settings") { if (await openSettings() === "exit") break; continue; }
      if (target.kind === "none") continue;
      const attempt = resolveProvider(environment, { provider: target.provider, model: target.model });
      if ("error" in attempt) { out.write(`${style.red(attempt.error)}\n`); continue; }
      if (attempt.spec.id === spec.id && attempt.model === resolvedModelId) {
        out.write(style.dim(`  already on ${spec.label} ${resolvedModelId}\n`));
        continue;
      }
      model = attempt.provider;
      spec = attempt.spec;
      prices = attempt.prices;
      resolvedModelId = attempt.model;
      ledger.setPrices(prices);
      agent = await openClient(await agent.relinquish());
      await checkBalance(true);
      const remembered = await rememberModelChoice(savedSettings, { id: spec.id, envPrefix: providerEnvPrefix(spec.id) }, resolvedModelId, processEnvironment, saveSettings);
      savedSettings = remembered.settings;
      if (remembered.environment) Object.assign(environment, remembered.environment);
      out.write(style.dim(`  switched to ${spec.label} ${resolvedModelId}${prices ? "" : " — no price configured, costs will show as unknown"}${remembered.note}\n`));
      continue;
    }
    const expandCommand = parseExpandCommand(input);
    if (expandCommand) {
      if (expandCommand.kind === "invalid") { out.write(style.yellow(`  ${expandCommand.reason}\n`)); continue; }
      if (expandCommand.kind === "list") { out.write(`${renderExpandableList(expandables.all, depth, glyphs)}\n`); continue; }
      const chosen = expandCommand.kind === "one"
        ? [expandables.get(expandCommand.id)]
        : expandCommand.kind === "all" ? [...expandables.all] : [expandables.last];
      const found = chosen.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      if (found.length === 0) {
        out.write(style.dim(`  nothing to expand${expandCommand.kind === "one" ? ` as ${expandCommand.id}` : ""} — /expand list shows what is folded\n`));
        continue;
      }
      for (const entry of found) {
        out.write(`${rule(sectionStyle(), { label: entry.label, tone: "accent" })}\n`);
        out.write(`${entry.full}\n`);
      }
      continue;
    }

    const memoryCommand = parseMemoryCommand(input);
    if (memoryCommand) {
      const style_ = sectionStyle();
      const files = { project: memoryFile("project", args.root, environment), user: memoryFile("user", args.root, environment) };
      switch (memoryCommand.kind) {
        case "invalid":
          out.write(style.yellow(`  ${memoryCommand.reason}\n`));
          break;
        case "where":
          out.write(`${note(`project ${glyphs.middot} ${files.project}`, style_)}\n${note(`you     ${glyphs.middot} ${files.user}`, style_)}\n`);
          break;
        case "list":
          out.write(`${renderMemories(memories, style_, files)}\n`);
          break;
        case "add": {
          try {
            const result = await addMemory(memoryCommand.scope, memoryCommand.text, args.root, environment, { kind: memoryCommand.memoryKind, pinned: memoryCommand.pinned });
            memories = await loadMemories(args.root, environment);
            out.write(result.changed
              ? `${describeAdded({ scope: memoryCommand.scope, text: memoryCommand.text }, style_)}\n`
              : style.dim("  already remembered\n"));
          } catch (error) {
            out.write(style.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
          }
          break;
        }
        case "replace": {
          try {
            await replaceMemory(memoryCommand.scope, memoryCommand.oldText, memoryCommand.newText, args.root, environment);
            memories = await loadMemories(args.root, environment);
            out.write(style.green(`  memory updated: ${memoryCommand.newText}\n`));
          } catch (error) {
            out.write(style.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
          }
          break;
        }
        case "recall": {
          const recalled = recallMemories(memories, memoryCommand.query);
          out.write(recalled.entries.length
            ? `${memoryPromptBlock(recalled.entries)}${style.dim(`  ${recalled.usedChars} chars recalled${recalled.omitted ? ` ${glyphs.middot} ${recalled.omitted} omitted by budget` : ""}\n`)}`
            : style.dim(`  no memory matched “${memoryCommand.query}”\n`));
          break;
        }
        case "forget": {
          const result = await forgetMemory(memoryCommand.scope, memoryCommand.index, args.root, environment);
          memories = await loadMemories(args.root, environment);
          out.write(result.removed
            ? style.green(`  forgot: ${result.removed.text}\n`)
            : style.yellow(`  there is no ${memoryCommand.scope} memory ${memoryCommand.index} — /memory lists them\n`));
          break;
        }
        case "clear": {
          const answer = (await readline.question(`  ${style.yellow("?")} Forget every ${memoryCommand.scope} memory? ${style.dim("[y/N]: ")}`)).trim().toLowerCase();
          if (answer !== "y" && answer !== "yes") { out.write(style.dim("  kept\n")); break; }
          await clearMemories(memoryCommand.scope, args.root, environment);
          memories = await loadMemories(args.root, environment);
          out.write(style.dim(`  ${memoryCommand.scope} memory cleared\n`));
          break;
        }
      }
      continue;
    }

    const paceCommand = parsePaceCommand(input, pace);
    if (paceCommand) {
      if (paceCommand.kind === "invalid") { out.write(style.yellow(`  ${paceCommand.reason}\n`)); continue; }
      if (paceCommand.kind === "show") { out.write(`${describePace(pace, sectionStyle())}\n`); continue; }
      pace = paceCommand.level;
      // The pace lives in the agent's budgets, which are fixed when the client is built — so the
      // client is rebuilt around the same session, exactly as a mode or model switch does.
      const previous = agent;
      const carried = await previous.relinquish();
      agent = await openClient(carried);
      out.write(`${describePace(pace, sectionStyle())}\n`);
      continue;
    }

    if (input === "/workspace" || input === "/panel") {
      /**
       * The control panel: every tab and every watched job, live, side by side.
       *
       * This is the one screen Archymedes draws rather than scrolls, and it is deliberately a *view* —
       * it reads the session and never mutates it, so leaving it puts you back exactly where you
       * were with nothing to undo.
       */
      // Lives for as long as the panel is open, which is the only span its samples mean anything
      // over: "lines since the last frame" is a rate only while the frames keep coming.
      const paneActivity = new PaneActivity();
      const readSnapshot = (): WorkspaceSnapshot => {
        const views = tabs.views(describeTab);
        const activeIndex = Math.max(0, views.findIndex((view) => view.active));
        const panes = [
            ...tabPanes(views, (id) => {
              const held = tabs.find(id);
              return { lines: held?.payload.sink.log.lines ?? [], dropped: held?.payload.sink.log.dropped ?? 0 };
            }),
            ...watched.all.map((job) => ({
              kind: "job" as const,
              key: job.stream.id,
              title: `job ${job.stream.id.slice(-6)}`,
              subtitle: job.objective,
              status: (job.stream.done ? "done" : "running") as "done" | "running",
              lines: job.sink.log.lines,
              dropped: job.sink.log.dropped,
            })),
        ];
        const activity = paneActivity.sample(panes);
        return {
          panes: panes.map((pane) => ({ ...pane, activity: activity.get(pane.key) })),
          selected: activeIndex,
          scroll: 0,
          palette,
          columns: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
        };
      };

      // The panel takes the terminal: raw mode, the alternate screen, and every keystroke. readline
      // and the pinned footer both have to let go first, or two things will be reading stdin and
      // one of them will be writing over the other.
      const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
        const { runWorkspace } = await import("./ui/workspace-screen");
        await runWorkspace({ read: readSnapshot });
      });
      // No text path for the panel — several live panes is the thing a transcript cannot express —
      // so a refusal is said plainly rather than swallowed.
      if (!outcome.ok) out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`));
      continue;
    }

    const guideCommand = parseGuideCommand(input);
    if (guideCommand) {
      const style_ = sectionStyle();

      /**
       * Opens the guide as a screen, and reports whether it happened.
       *
       * A `false` return is not an error — it means the printed guide below is the right answer for
       * this terminal, which is true for a pipe, a window too small to hold a page, and a build
       * where the framework was pruned. See `docs/reference/terminal-design-system.md` §10.
       */
      const openGuideScreen = async (startAt?: string): Promise<boolean> => {
        const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
          const { runGuideScreen } = await import("./ui/guide-screen");
          await runGuideScreen({
            columns: process.stdout.columns ?? 80,
            rows: process.stdout.rows ?? 24,
            palette,
            ...(startAt ? { startAt } : {}),
          });
        });
        return outcome.ok;
      };

      if (guideCommand.kind === "index") {
        // A bare /guide is "show me the manual", which is a browsing job. The printed index stays
        // for pipes and for terminals that cannot draw a screen.
        if (await openGuideScreen()) continue;
        out.write(`${renderGuideIndex(style_)}\n`);
        continue;
      }
      if (guideCommand.kind === "all") {
        // Folded, because the whole guide is longer than a screen and printing it at someone is how
        // a manual becomes something they scroll past rather than read.
        const whole = renderWholeGuide(style_);
        const lines = whole.split("\n");
        out.write(`${lines.slice(0, FOLD_AFTER_LINES * 3).join("\n")}\n`);
        const hidden = Math.max(0, lines.length - FOLD_AFTER_LINES * 3);
        if (hidden > 0) {
          const id = expandables.add("guide", whole, hidden);
          out.write(`${GUTTER}${expandHint(id, hidden, renderDepth, glyphs)}\n`);
        }
        continue;
      }
      if (guideCommand.kind === "search") {
        const found = searchTopics(guideCommand.query);
        if (found.length === 0) { out.write(style.yellow(`  Nothing in the guide mentions "${guideCommand.query}".\n`)); continue; }
        out.write(`${heading(`guide ${glyphs.middot} "${guideCommand.query}"`, 2, style_)}\n`);
        for (const topic of found) out.write(`${GUTTER}${style.cyan(topic.id)}  ${style.dim(topic.summary)}\n`);
        continue;
      }
      if (guideCommand.kind === "unknown") {
        out.write(style.yellow(`  No guide topic called "${guideCommand.id}".\n`));
        out.write(style.dim("  /guide lists them · /guide search <text> finds one\n"));
        continue;
      }
      const topic = findTopic(guideCommand.id);
      // A named topic prints. Someone who typed `/guide tabs` asked for that page, and a page in
      // the transcript can be scrolled back to, copied and piped; a screen takes it away again.
      if (topic) out.write(`${renderGuideTopic(topic, style_)}\n`);
      continue;
    }

    if (input === "/files") {
      // The flat list already loaded for `@path` completion — opening the picker costs nothing
      // beyond what a session already pays for that, and the two now agree on exactly which files
      // are reachable.
      let picked: { path: string; intent: "mention" | "edit" } | undefined;
      const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
        const { runFileScreen } = await import("./ui/file-screen");
        picked = await runFileScreen({
          columns: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
          paths: projectFiles,
          palette,
          readFile: async (path) => {
            const result = await workspace.readFile(path, { limit: 200 });
            return { content: result.content, totalLines: result.totalLines, truncated: result.truncated };
          },
        });
      });
      if (!outcome.ok) { out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`)); continue; }
      if (picked?.intent === "edit") { await editFile(picked.path); continue; }
      // Picking a file writes an `@path` mention into the line still being composed — the same
      // syntax typing `@` and tab-completing already produces, so the model sees one convention
      // for "this file", not two.
      if (picked) rl.write(`@${picked.path} `);
      continue;
    }

    if (input === "/edit" || input.startsWith("/edit ")) {
      const target = input.slice("/edit".length).trim();
      if (!target) { out.write(style.yellow("  Usage: /edit <path>, or press e on a file in /files.\n")); continue; }
      await editFile(target);
      continue;
    }

    const findRequest = parseFindCommand(input);
    if (findRequest) {
      const message = describeFind(screen instanceof WorkspaceFrame ? screen.find(findRequest) : undefined);
      if (message) out.write(style.dim(`  ${message}\n`));
      continue;
    }

    if (input === "/pager") {
      const log = tabs.active.payload.sink.log;
      let pager: { opened: boolean; reason?: string } = { opened: false };
      const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => { pager = await runPager(log, environment); });
      if (!outcome.ok) out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`));
      else if (!pager.opened && pager.reason) out.write(style.yellow(`  ${pager.reason}\n`));
      continue;
    }

    if (input === "/cat" || input.startsWith("/cat ")) {
      await runCat(input.slice("/cat".length).trim(), {
        readFile: (target) => workspace.readFile(target, {}),
        ...(workspace instanceof LocalWorkspace ? { readBytes: (target: string) => (workspace as LocalWorkspace).readBytes(target) } : {}),
        write: (text) => out.write(text),
        warn: (text) => out.write(style.yellow(`  ${text}\n`)),
        writeFoldable,
        style: sectionStyle(),
        width: contentWidth(),
        foldAfterLines: FOLD_AFTER_LINES,
        images: imagePreference(environment, screen instanceof WorkspaceFrame ? "fixed" : "scrollback"),
        imageRows: Math.max(6, (process.stdout.rows ?? 24) - 8),
        onKittyImage: (id) => kittyImages.push(id),
        nextImageId: () => kittyImages.length + 1,
      });
      continue;
    }

    const themeCommand = parseThemeCommand(input);
    if (themeCommand) {
      const style_ = sectionStyle();
      if (themeCommand.kind === "invalid") { out.write(style.yellow(`  ${themeCommand.reason}\n`)); continue; }
      if (themeCommand.kind === "where") {
        out.write(`${heading("themes", 2, style_)}\n`);
        for (const scope of ["project", "user"] as const) {
          out.write(`${note(`${scope}: ${themeDirectory(scope, args.root, environment)}`, style_)}\n`);
        }
        out.write(`${note("drop a .tss file in either — the same format TermUI themes use", style_)}\n`);
        continue;
      }
      if (themeCommand.kind === "list") {
        const available = await discoverThemes(args.root, environment);
        out.write(`${heading("themes", 2, style_)}\n`);
        for (const theme of available) {
          const marker = theme.name === themeName ? glyphs.circleFull : " ";
          const origin = theme.source === "builtin" ? "" : ` (${theme.source})`;
          out.write(`${GUTTER}${marker} ${style.cyan(theme.name)}${style.dim(origin)}${theme.description ? style.dim(` — ${theme.description}`) : ""}\n`);
        }
        out.write(`${note("/theme <name> to change it", style_)}\n`);
        continue;
      }
      if (themeCommand.kind === "show") {
        out.write(`${GUTTER}${style.cyan(themeName)}${activeTheme?.description ? style.dim(` — ${activeTheme.description}`) : ""}\n`);
        // A swatch of the roles, because the names mean nothing until they are seen next to
        // each other in the terminal that will actually be drawing them.
        out.write(`${GUTTER}${style.cyan("primary")}  ${style.accent("accent")}  ${style.green("success")}  ${style.yellow("warning")}  ${style.red("error")}  ${style.dim("muted")}\n`);
        continue;
      }
      const chosen = await findTheme(themeCommand.name, args.root, environment);
      if (!chosen) {
        out.write(style.yellow(`  No theme named "${themeCommand.name}". /theme list shows what there is.\n`));
        continue;
      }
      activeTheme = chosen;
      applyTheme(chosen);
      out.write(`${rule(sectionStyle(), { label: chosen.name, tone: "accent" })}\n`);
      out.write(`${GUTTER}${style.cyan("primary")}  ${style.accent("accent")}  ${style.green("success")}  ${style.yellow("warning")}  ${style.red("error")}  ${style.dim("muted")}\n`);
      continue;
    }

    const historyCommand = parseHistoryCommand(input);
    if (historyCommand) {
      await runHistoryCommand(historyCommand, {
        stateHistory,
        listSessions: (limit) => listSessions(args.root, limit),
        loadSession: (id) => loadSession(args.root, id),
        currentSessionId: agent.sessionId,
        ...(interactive ? {
          choose: (items) => openChooser<string>({ readline, input: process.stdin, output: process.stdout }, items,
            { title: "Pick up a past conversation", filter: true, height: 12, glyphs, paint: { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow } }),
        } : {}),
        resume: async (record) => {
          await agent.relinquish();
          if (record.mode) mode = record.mode;
          agent = await openClient(record);
          await carryResumedSpend(agent.snapshot());
          expandables.clear();
        },
        write: (text) => out.write(text),
        paint: style,
        style: sectionStyle(),
        glyphs,
      });
      continue;
    }

    if (input === "/todos" || input === "/task") {
      // The two read-only "where do things stand" commands, rendered by `session-inspect.ts` from
      // an explicit snapshot rather than from this loop's locals — the first handler extraction.
      const inspect: InspectContext = {
        style: sectionStyle(),
        glyphs,
        depth,
        plan: agent.todos,
        request: sessionRequest,
        files: [...sessionFiles],
        checks: [...sessionChecks],
        lastTurnStatus,
        turnsTaken: sessionRequest !== undefined,
      };
      if (input === "/todos") {
        const todos = renderTodos(inspect);
        if (todos === null) { out.write(style.dim("  no plan yet\n")); writeHint(); continue; }
        out.write(`${todos}\n`);
        continue;
      }
      out.write(`${renderTask(inspect)}\n`);
      writeHint();
      continue;
    }
    if (input === "/route plan") {
      // A preflight, not a turn: it calls no model, reserves nothing, and leaves the conversation
      // exactly as it was — so it stays interruptible and never becomes a way to spend money.
      const planning = new AbortController();
      pendingReadAbort = planning;
      let plan: Awaited<ReturnType<typeof agent.planRoute>>;
      try {
        plan = await agent.planRoute("", planning.signal);
      } catch (error) {
        if (planning.signal.aborted) { out.write(style.dim("  routing plan cancelled\n")); writeHint(); continue; }
        out.write(style.dim(`  routing plan unavailable — ${error instanceof Error ? error.message : String(error)}\n`));
        writeHint();
        continue;
      } finally {
        pendingReadAbort = undefined;
      }
      if (plan === null) {
        out.write(style.dim("  /route plan needs the archymedes-cloud provider — a direct provider has one route\n"));
        writeHint();
        continue;
      }
      out.write(`${renderRoutingPlan(plan, sectionStyle())}\n`);
      writeHint();
      continue;
    }
    if (input === "/route" || input === "/route all" || input === "/route summary") {
      const sessionReceipts = agent.routingReceipts;
      if (sessionReceipts.length === 0) {
        out.write(style.dim("  no hosted routing this session — /route needs the archymedes-cloud provider\n"));
        writeHint();
        continue;
      }
      if (input === "/route summary") {
        out.write(`${renderRoutingSummary(sessionReceipts, sectionStyle())}\n`);
        writeHint();
        continue;
      }
      const shown = input === "/route all" ? sessionReceipts : sessionReceipts.slice(-1);
      for (const [index, receipt] of shown.entries()) {
        out.write(`${renderRoutingReceipt(receipt, sectionStyle())}\n`);
        if (index < shown.length - 1) out.write("\n");
      }
      writeHint();
      continue;
    }
    if (input === "/diff" || input === "/diff stat") {
      // The stat is still one word away, because "how much changed" is a real question — it is
      // just not the one `/diff` was being asked.
      if (input === "/diff stat") {
        const stat = await agent.diffStat();
        if (stat) out.write(`${box(stat.split("\n"), { depth, title: "diff", glyphs, palette })}\n`);
        else { out.write(style.dim("  nothing changed since the last checkpoint\n")); writeHint(); }
        continue;
      }
      const patch = await agent.diffPatch();
      if (!patch.trim()) { out.write(style.dim("  nothing changed since the last checkpoint\n")); writeHint(); continue; }
      const rendered = renderPatch(patch, sectionStyle(), { maxLinesPerFile: FOLD_AFTER_LINES * 2 });
      out.write(`${rendered.text}\n`);
      if (widestRow(rendered.text) > contentWidth()) out.write(style.dim("  some lines are wider than this window — /pager shows them unwrapped\n"));
      // The whole patch stays addressable: a folded file is the common case on a real change, and
      // the alternative — printing four hundred lines at someone — is why people stop typing /diff.
      const hiddenLines = patch.split("\n").length;
      const id = expandables.add("diff", renderPatch(patch, sectionStyle()).text, hiddenLines);
      out.write(`${GUTTER}${expandHint(id, hiddenLines, renderDepth, glyphs)}\n`);
      continue;
    }
    const tabCommand = parseTabCommand(input);
    if (tabCommand) {
      await runTabCommand(tabCommand, {
        tabs,
        resolve: (request) => resolveProvider(environment, request),
        sessionWorkspace: workspace,
        startWorkspace: (backend) => createWorkspace({ backend }),
        openTab: async (title, wanted, tabWorkspace, backend) => {
          // Opened before tabs.open(): WorkspaceController's factory is synchronous.
          const client = await openClient(undefined, { provider: wanted.provider, prices: wanted.prices, workspace: tabWorkspace });
          return tabs.open(title, () => ({
            agent: client,
            ledger: new CostLedger({ prices: wanted.prices, display, rates, catalog: PRICE_CATALOG, ...(approvedBudget ? { budget: approvedBudget } : {}) }),
            mode,
            sink: new TabSink(sessionStream),
            provider: wanted.provider,
            spec: wanted.spec,
            prices: wanted.prices,
            modelId: wanted.model,
            backend: backend ?? args.backend,
            workspace: tabWorkspace,
            ownsWorkspace: tabWorkspace !== workspace,
          }));
        },
        stashActiveTab,
        enterTab,
        switchTab,
        showTabs,
        describeLocation,
        firstTabExplanation: () => !explainedTabs && (explainedTabs = true),
        write: (text) => out.write(text),
        paint: style,
        glyphs,
      });
      continue;
    }

    const wander = parseWanderCommand(input);
    if (wander) {
      if (wander.kind === "invalid") {
        out.write(style.yellow(`  ${wander.reason}\n`));
        continue;
      }
      if (wander.kind === "schedule") {
        // Recurring Wander is a durable job, not a turn: it has to survive this process exiting.
        // The first occurrence runs now; a completed one re-queues itself for the next, so one
        // detached worker process carries the whole schedule without needing a system cron entry.
        const id = newJobId();
        const objective = wanderJobObjective(wander);
        const job = await enqueueJob(args.root, { id, objective, logPath: jobLogPath(args.root, id), cadence: wander.cadence, runAt: Date.now() });
        await spawnJobWorker(args.root, job.id);
        out.write(`  ${style.cyan("scheduled")} — job ${job.id} runs now, then every ${wander.cadence === "daily" ? "day" : "week"} after the last one finishes.\n`);
        out.write(style.dim(`  /attach ${job.id} to watch it · /jobs cancel ${job.id} to stop it\n`));
        continue;
      }

      // The lab may cite only what the dossier holds, and the agent may have no network at all, so
      // the search happens here — once, before the turn — and the result is written where the
      // protocol says the scout left it.
      out.write(`  ${style.cyan("wander")} ${style.dim(wander.random ? `picked: ${wander.topic}` : wander.topic)}\n`);
      const evidence = await gatherWanderEvidence(wander.topic, createExaClient(environment));
      if (evidence.expense) ledger.recordExpense(evidence.expense);
      await workspace.writeFile(WANDER_LAB_FILES.evidence, evidence.markdown);
      out.write(style.dim(`  ${evidence.hits.length} source${evidence.hits.length === 1 ? "" : "s"} → ${WANDER_LAB_FILES.evidence}\n`));
      input = buildWanderPrompt(wander.topic);
      wanderRunning = true;
    }

    const jobsCommand = parseJobsCommand(input);
    if (jobsCommand) {
      try {
        switch (jobsCommand.kind) {
          case "invalid":
            out.write(style.yellow(`  ${jobsCommand.reason}\n`));
            break;
          case "list": {
            const jobs = await listJobs(args.root);
            if (jobs.length === 0) {
              out.write(style.dim("  no background jobs — /jobs run <task>, /detach <task>, or /wander daily to start one\n"));
              break;
            }
            // A table rather than the padded line this printed before. The columns were always
            // there — id, status, attempts, what it is waiting on — and `.padEnd(9)` only lined up
            // the second of them, so a long objective pushed every following field somewhere new on
            // each row and the one job that had failed was no easier to find than the rest.
            const listed = buildJobsTable(jobs, { paint: surfacePaint, glyphs });
            out.write(`${renderTable(listed.columns, listed.rows, INITIAL_TABLE_STATE, {
              paint: surfacePaint, width: contentWidth(), glyphs, legend: "", cursor: false,
            })}\n`);
            break;
          }
          case "run": {
            const job = await startBackgroundJob(jobsCommand.objective);
            out.write(`  ${style.cyan("started")} job ${job.id} in the background. /attach ${job.id} to watch it.\n`);
            break;
          }
          case "cancel": {
            // The lease's owner (host:pid) is cleared the instant the store marks the job
            // cancelled, so the pid to signal has to be read before that happens.
            const before = await getJob(args.root, jobsCommand.id);
            const { ok } = await cancelJob(args.root, jobsCommand.id);
            if (!ok) { out.write(style.yellow(`  No job ${jobsCommand.id} to cancel — it may already be finished.\n`)); break; }
            const pid = Number(before?.lease?.workerId.split(":").pop());
            if (Number.isInteger(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
            out.write(`  cancelled ${jobsCommand.id}.\n`);
            break;
          }
          case "approve": {
            // `/jobs approve <id>` names a job, not an action, so the action has to be read back
            // and shown before the decision is bound to it — otherwise this authorizes whatever
            // the job happens to be asking for now, which is the hole this whole path closes.
            const pending = (await getJob(args.root, jobsCommand.id))?.pendingApproval;
            if (!pending) { out.write(style.yellow(`  ${jobsCommand.id} has no pending approval.\n`)); break; }
            out.write(style.dim(`  ${jobsCommand.decision === "deny" ? "denying" : "approving"}: ${pending.summary}\n`));
            const ok = await resolveJobApproval(args.root, jobsCommand.id, jobsCommand.decision, pending.actionDigest);
            out.write(ok ? `  delivered — the worker will pick it up shortly.\n` : style.yellow(`  that request changed before your answer arrived — nothing was authorized.\n`));
            break;
          }
        }
      } catch (error) {
        out.write(style.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
      continue;
    }

    const detachCommand = parseDetachCommand(input);
    if (detachCommand) {
      if (detachCommand.kind === "invalid") {
        out.write(style.yellow(`  ${detachCommand.reason}\n`));
        continue;
      }
      const job = await startBackgroundJob(detachCommand.objective);
      out.write(`  ${style.cyan("started")} job ${job.id} in the background. /attach ${job.id} to watch it.\n`);
      continue;
    }

    if (input === "/watch" || input.startsWith("/watch ")) {
      const rest = input.slice("/watch".length).trim().replace(/\s+/g, " ");
      const style_ = sectionStyle();

      if (!rest) {
        if (watched.size === 0) { out.write(style.dim("  watching nothing — /watch <job id>, or /jobs to see what exists\n")); continue; }
        out.write(`${heading("watching", 2, style_)}\n`);
        for (const job of watched.all) {
          const status = job.stream.done ? job.stream.status : "live";
          out.write(`${GUTTER}${style.cyan(job.stream.id)} ${style.dim(`${status} ${glyphs.middot} ${job.sink.log.size} lines`)}  ${job.objective}\n`);
        }
        out.write(`${note("/watch show <id> to read it · /watch stop <id> to stop", style_)}\n`);
        continue;
      }

      const [verb, ...words] = rest.split(" ");
      const target = words.join(" ").trim();

      if (verb === "stop") {
        if (target === "all") { watched.stopAll(); out.write(style.dim("  stopped watching everything\n")); continue; }
        const stopped = watched.stop(target);
        out.write(stopped ? style.dim(`  stopped watching ${target}\n`) : style.yellow(`  not watching ${target}\n`));
        continue;
      }

      if (verb === "show") {
        const job = watched.get(target);
        if (!job) { out.write(style.yellow(`  not watching ${target}\n`)); continue; }
        // Printed from the job's own record rather than re-read from the log: this is exactly what
        // the stream has received, which is the thing being asked about.
        const replay = replayLines(job.sink.log, 200);
        out.write(`${rule(style_, { label: `job ${target}`, tone: "accent", ...(replay.omitted > 0 ? { trailing: `${replay.omitted} earlier lines` } : {}) })}\n`);
        if (replay.lines.length === 0) out.write(`${note("nothing yet", style_)}\n`);
        for (const line of replay.lines) out.write(`${line}\n`);
        continue;
      }

      const id = verb;
      const job = await getJob(args.root, id);
      if (!job) { out.write(style.yellow(`  No job ${id}. /jobs lists what exists.\n`)); continue; }
      await startWatching(id, job.objective);
      out.write(style.dim(`  watching ${id} — it keeps running while you work; /watch show ${id} to read it\n`));
      continue;
    }

    const attachCommand = parseAttachCommand(input);
    if (attachCommand) {
      if (attachCommand.kind === "invalid") {
        out.write(style.yellow(`  ${attachCommand.reason}\n`));
        continue;
      }
      const first = await getJob(args.root, attachCommand.id);
      if (!first) {
        out.write(style.yellow(`  No job ${attachCommand.id}. /jobs lists what exists.\n`));
        continue;
      }
      out.write(style.dim(`  attached to ${attachCommand.id} (${describeJobForHuman(first)}) — Ctrl+C returns to the prompt without stopping it\n`));
      let offset = 0;
      // Ctrl+C here must only end the attach view, not the whole session — swap the interrupt
      // handler for the duration so it does not fall through to the ordinary "quit" behaviour.
      let detachView = false;
      const onAttachSigint = () => { detachView = true; };
      unbindSigint();
      process.on("SIGINT", onAttachSigint);
      readline.on("SIGINT", onAttachSigint);
      try {
        for (;;) {
          const chunk = await readJobLog(args.root, attachCommand.id, offset);
          if (chunk.text) out.write(chunk.text);
          offset = chunk.nextByte;
          if (detachView) break;
          const current = await getJob(args.root, attachCommand.id);
          if (!current) break;
          if (current.pendingApproval) {
            // The digest read here is the one displayed; answering it authorizes that action only.
            // Re-reading the job after the question would race a worker that re-parked a different
            // call while the human was typing, and silently redirect the answer onto it.
            const { summary, actionDigest } = current.pendingApproval;
            const answer = (await readline.question(`  ${style.yellow("approval needed:")} ${summary} [y/N]: `)).trim().toLowerCase();
            const applied = await resolveJobApproval(args.root, attachCommand.id, answer === "y" || answer === "yes" ? "allow" : "deny", actionDigest);
            if (!applied) out.write(style.yellow("  That request changed before your answer arrived — nothing was authorized.\n"));
            continue;
          }
          if (isTerminal(current.status)) { out.write(style.dim(`  job ${current.status}\n`)); break; }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } finally {
        process.off("SIGINT", onAttachSigint);
        readline.off("SIGINT", onAttachSigint);
        bindSigint();
      }
      continue;
    }

    if (input === "/keys") {
      out.write(`${keys.render()}\n\n${renderKeyboardShortcuts(language)}\n`);
      continue;
    }
    if (input === "/undo" || input.startsWith("/undo ")) {
      const argument = input.slice("/undo".length).trim();
      const scope = argument === "code" || argument === "conversation" ? argument : argument === "" ? "both" : null;
      if (scope === null) {
        out.write(style.yellow(`  /undo takes no argument, "code", or "conversation" — not "${argument}".\n`));
        continue;
      }
      const restored = await agent.undo(scope);
      const label = scope === "code" ? "reverted the files for" : scope === "conversation" ? "rewound the conversation before" : "reverted";
      out.write(restored ? style.green(`  ${label} "${restored.label}"\n`) : style.yellow("  nothing to undo\n"));
      continue;
    }
    if (input === "/clear") {
      if (kittyImages.length > 0) { process.stdout.write(clearKittyImages(kittyImages)); kittyImages.length = 0; }
      await agent.relinquish();
      agent = await openClient();
      // A new thread has neither the old thread's folded output nor its remembered context.
      expandables.clear();
      out.write(style.dim("  new thread\n"));
      continue;
    }
    if (input.startsWith("/pull")) {
      if (workspace.kind !== "e2b") { out.write(style.yellow("  already working locally — nothing to pull\n")); continue; }
      const destination = path.resolve(args.root, input.split(/\s+/)[1] ?? "archymedes-pull");
      const pulled = await downloadProject(workspace, destination);
      out.write(style.green(`  pulled ${pulled.written.length} files into ${destination}\n`));
      if (pulled.failed.length > 0) out.write(style.yellow(`  ${pulled.failed.length} could not be read\n`));
      continue;
    }
    if (input === "/providers") {
      out.write(`${renderProviders(environment, depth)}\n`);
      continue;
    }
    if (input === "/settings") {
      if (await openSettings() === "exit") break;
      continue;
    }
    if (input.startsWith("/voice")) {
      const supplied = input.slice("/voice".length).trim();
      let audioFile = supplied ? path.resolve(args.root, supplied) : "";
      let temporary = false;
      try {
        if (!audioFile) {
          const recording = await startRecording(environment);
          audioFile = recording.file;
          temporary = true;
          await readline.question(`  ${style.red("● recording")} — speak naturally, then press Enter to stop `);
          await recording.stop();
        }
        out.write(style.dim("  transcribing…\n"));
        let transcript = await transcribeAudio(audioFile, environment);
        out.write(`${box(transcript.split("\n"), { depth, title: "voice transcript", glyphs, palette })}\n`);
        const decision = (await readline.question("  Send this prompt? [Y/n/e to edit]: ")).trim().toLowerCase();
        if (decision === "n" || decision === "no") continue;
        if (decision === "e" || decision === "edit") transcript = (await readline.question("  Edit prompt: ")).trim() || transcript;
        await runTurn(transcript);
      } catch (error) {
        out.write(style.red(`  Voice input failed: ${error instanceof Error ? error.message : String(error)}\n`));
      } finally {
        if (temporary && audioFile) await removeRecording(audioFile).catch(() => undefined);
      }
      continue;
    }
    if (input === "/cost") {
      out.write(renderCostReport({ report: ledger.formatReport(), history: ledger.history, display, rates, paint: surfacePaint, glyphs, depth: renderDepth, width: contentWidth() }));
      const fraction = ledger.budgetFraction;
      if (fraction !== undefined) await animateBudgetMeter(fraction, { out, palette, depth: renderDepth, glyphs, dim: style.dim });
      continue;
    }
    if (input === "/update" || input.startsWith("/update ")) {
      const argument = input.slice("/update".length).trim().toLowerCase();
      if (argument) {
        // Setting the policy, not running an update. Persisted, so the answer survives the session
        // that gave it — an update preference nobody remembers giving is worse than none.
        const mode = argument === "auto" || argument === "install" || argument === "on" ? "install"
          : argument === "off" || argument === "never" ? "off"
          : argument === "check" || argument === "notify" ? "check"
          : undefined;
        if (!mode) {
          out.write(style.yellow("  Say /update auto, /update check or /update off — or /update on its own to install now.\n"));
          continue;
        }
        const saved = await saveSettings({ ...await loadSettings(environment), ARCHYMEDES_AUTO_UPDATE: mode }, environment).catch(() => undefined);
        environment.ARCHYMEDES_AUTO_UPDATE = mode;
        const described = mode === "install" ? "check daily and install automatically"
          : mode === "check" ? "check daily and tell you" : "never check for updates";
        out.write(`  ${style.green(glyphs.check)} Archymedes will ${described}.${saved ? "" : style.dim(" (not saved — settings are read-only here)")}\n`);
        continue;
      }

      out.write(style.dim(`  checking for a newer Archymedes than ${ARCHYMEDES_CLI_VERSION}…\n`));
      const latest = await fetchLatestVersion({ environment, timeoutMs: 10_000 }).catch(() => undefined);
      if (!latest) {
        out.write(style.yellow("  Could not reach the registry. Nothing was changed.\n"));
        continue;
      }
      const versionOrder = compareVersions(ARCHYMEDES_CLI_VERSION, latest);
      if (versionOrder === 0) {
        out.write(`  ${style.green(glyphs.check)} Already on the newest version (${latest}).\n`);
        continue;
      }
      if (versionOrder > 0) {
        out.write(`  ${style.green(glyphs.check)} This Archymedes (${ARCHYMEDES_CLI_VERSION}) is newer than the registry release (${latest}); no downgrade offered.\n`);
        continue;
      }
      statusBar.clear();
      const confirmation = (await readline.question(`  ${style.yellow("?")} Install Archymedes ${style.bold(latest)}, replacing ${ARCHYMEDES_CLI_VERSION}? ${style.dim("[y/N]: ")}`)).trim().toLowerCase();
      if (confirmation !== "y" && confirmation !== "yes") {
        out.write(style.dim("  Left as it is.\n"));
        continue;
      }
      // `yes` because the question above was the consent; a second prompt from inside the updater
      // would be asking the same thing twice through a second readline on the same terminal.
      const result = await runSelfUpdate({
        yes: true,
        interactive: false,
        environment,
        stdout: (text) => out.write(text),
        stderr: (text) => out.write(style.yellow(text)),
      });
      out.write(result.status === "updated"
        ? `  ${style.green(glyphs.check)} Updated to ${result.latestVersion}. This session keeps running ${ARCHYMEDES_CLI_VERSION} until you restart.\n`
        : style.yellow(`  Update did not complete (${result.status}).\n`));
      continue;
    }

    const manualBalanceCommand = parseManualBalanceCommand(input);
    if (manualBalanceCommand) {
      if (manualBalanceCommand.kind === "invalid") {
        out.write(style.yellow(`  ${manualBalanceCommand.reason}\n`));
        continue;
      }
      if (manualBalanceCommand.kind === "set") {
        const currency = manualBalanceCommand.currency ?? display;
        const next: Balance = { amount: manualBalanceCommand.amount, currency, asOf: Date.now() };
        const file = await persistManualBalance(next);
        out.write(style.green(`  Balance set to ${formatBalance(next.amount, currency)}. Archymedes will subtract each turn's measured cost from it.\n`));
        out.write(style.dim(`  This is a local estimate, not a provider statement. Saved to ${file}; /balance clear stops tracking.\n`));
        continue;
      }
      if (manualBalanceCommand.kind === "clear") {
        await persistManualBalance(undefined);
        out.write(style.dim("  Balance tracking cleared. Set a new figure any time with /balance <amount>.\n"));
        continue;
      }
      // On the exchange the account has a real ledger, and that — not a figure someone typed — is
      // what the next turn reserves against. Read it first, and say plainly when it cannot be read
      // rather than falling back to the local number as though it were the same thing.
      const hosted = model as typeof model & { creditBalance?: (signal?: AbortSignal) => Promise<HostedCreditBalance | null> };
      if (typeof hosted.creditBalance === "function") {
        const reading = new AbortController();
        pendingReadAbort = reading;
        try {
          const credits = await hosted.creditBalance(reading.signal);
          if (credits) {
            for (const line of renderHostedBalance(credits, { localCurrency: display })) out.write(`  ${line}\n`);
          } else {
            out.write(style.yellow("  The exchange did not return a readable balance.\n"));
          }
        } catch (error) {
          if (reading.signal.aborted) out.write(style.dim("  balance check cancelled\n"));
          else out.write(style.yellow(`  Could not read the hosted balance — ${error instanceof Error ? error.message : String(error)}\n`));
        } finally {
          pendingReadAbort = undefined;
        }
        const localTracked = currentBalance();
        if (localTracked) {
          // Both exist, so both are shown — labelled, never summed.
          out.write(style.dim(`  Separately, you are tracking ${formatBalance(localTracked.amount, localTracked.currency)} locally as a pacing limit.\n`));
        }
        continue;
      }
      const balance = currentBalance();
      if (balance) {
        for (const line of renderBalance(balance, criticalBalance, { sessionSpend: sessionSpend() })) out.write(`  ${line}\n`);
        out.write(style.dim("  Local estimate: the figure you set minus Archymedes's measured token costs. /balance <amount> resets it.\n"));
      } else {
        out.write(style.dim("  No balance is being tracked. Use /balance <amount> [currency] to track one locally.\n"));
      }
      continue;
    }

    if (input === "/scan" || input.startsWith("/scan ")) {
      lastScanFindings = await runScan(input.slice("/scan".length).trim() || undefined, {
        scanSecrets: (include) => agent.scanSecrets(include),
        readWindow: (file, offset, limit) => agent.readFile(file, { offset, limit }).catch(() => null),
        ...(interactive && liveTerminal ? {
          triage: (findings, loadEvidence) => openDefenderTriage({ readline, input: process.stdin, output: process.stdout }, findings, { style: { depth: renderDepth, glyphs }, loadEvidence }),
        } : {}),
        queueFirst: (objectives) => queuedInput.unshift(...objectives),
        write: (text) => out.write(text),
        paint: style,
        glyphs,
        depth: renderDepth,
        width: contentWidth(),
      });
      continue;
    }
    if (input === "/where") {
      out.write(`  ${workspace.kind === "e2b" ? style.yellow(workspace.label) : style.dim(workspace.label)}\n`);
      continue;
    }
    if (input === "/tools") {
      const inspected = await agent.inspectTools();
      const contributing = new Set(inspected.tools.map((tool) => (tool.provenance && tool.provenance.kind !== "built-in" ? `${tool.provenance.kind}:${tool.provenance.providerId}` : "built-in")));
      out.write(`${renderTools({
        tools: inspected.tools,
        hooks: inspected.hooks,
        // A configured source that contributed nothing is worth naming — it usually means a wrong
        // path in a manifest. The always-present `.archymedes/skills` reader is not: a project with no
        // skills is the ordinary case, and reporting it as an anomaly to everyone who has none is
        // noise dressed as a warning.
        emptyProviders: inspected.providerIds
          .filter((id) => !contributing.has(id) && id !== `skill:${IMPLICIT_SKILL_PROVIDER_ID}`),
      }, style)}\n`);
      continue;
    }
    if (input.startsWith("/") && !isKnownCommand(input.split(/\s+/)[0])) {
      // Without this the typo is simply sent to the model, which costs a round trip to be told
      // it makes no sense.
      const name = input.split(/\s+/)[0];
      const suggestion = suggestCommand(name);
      out.write(`  ${style.yellow(`Unknown command ${name}.`)}${style.dim(suggestion ? ` Did you mean ${suggestion}?` : " Type /help for the list.")}\n`);
      continue;
    }

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
      const job = await enqueueJob(args.root, { id, objective: `Continue: ${input}`, logPath: jobLogPath(args.root, id), sessionId });
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
