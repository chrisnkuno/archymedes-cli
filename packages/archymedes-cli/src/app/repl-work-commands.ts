/**
 * Slash commands that start, move or account for work: `/wander`, `/jobs`, `/detach`, `/watch`,
 * `/attach`, `/keys`, `/undo`, `/clear`, `/pull`, `/providers`, `/settings`, `/upgrade`, `/voice`,
 * `/cost`, `/update`, `/balance`, `/scan`, `/where`, `/diagnostics`, `/tools`, and saved prompts
 * under `.archymedes/commands`.
 *
 * Moved out of the REPL loop unchanged; see `SlashOutcome` for what the result means.
 */
import path from "node:path";
import { cancelJob, enqueueJob, getJob, IMPLICIT_SKILL_PROVIDER_ID, isTerminal, jobLogPath, listJobs, newJobId, readJobLog, resolveJobApproval } from "@archymedes/core";
import { downloadProject } from "@archymedes/core/cli/backends";
import { collectWorkspaceDiagnostics } from "@archymedes/core/lsp/collect";
import { resolveProvider } from "@archymedes/core/providers/agent-matrix";
import { type CreditBalance as HostedCreditBalance } from "@archymedes/core/providers/credit-balance";
import { createExaClient } from "@archymedes/core/providers/exa";
import { WANDER_LAB_FILES } from "@archymedes/core/wander";
import { isKnownCommand, renderKeyboardShortcuts } from "../catalog/commands";
import { runAttach } from "../commands/attach";
import { parseManualBalanceCommand } from "../commands/balance";
import { runBalanceCommand } from "../commands/balance-command";
import { animateBudgetMeter, renderCostReport } from "../commands/cost";
import { runDiagnosticsCommand } from "../commands/diagnostics";
import { parseAttachCommand, parseDetachCommand, parseJobsCommand } from "../commands/jobs-command";
import { runJobsCommand } from "../commands/jobs-runner";
import { runScan } from "../commands/scan";
import { resolveSlashInput } from "../commands/slash-input";
import { renderTools } from "../commands/tools-command";
import { runUpdateCommand } from "../commands/update-command";
import { runUpgradeCommand } from "../commands/upgrade-command";
import { removeRecording, startRecording, transcribeAudio } from "../commands/voice";
import { buildWanderPrompt, gatherWanderEvidence, parseWanderCommand, wanderJobObjective } from "../commands/wander";
import { runWatchCommand } from "../commands/watch-command";
import { describeJobForHuman } from "../job-worker";
import { loadSettings, mergedEnvironment, saveSettings, SETTING_FIELDS } from "../platform/settings";
import { ARCHYMEDES_CLI_VERSION, compareVersions, fetchLatestVersion, runSelfUpdate } from "../platform/update";
import { clearKittyImages } from "../render/image-view";
import { box } from "../render/tui";
import { openDefenderTriage } from "../ui/shortcuts";
import { spawnJobWorker } from "./job-launch";
import { hiddenQuestion } from "./prompts";
import { renderProviders } from "./providers";
import { contentWidth, expandables, glyphs, liveTerminal, out, palette, renderDepth, sectionStyle, statusBar, style, surfacePaint } from "./transcript";
import type { ReplContext, SlashOutcome } from "./repl-context";

export async function dispatchWorkCommand(input: string, context: ReplContext): Promise<SlashOutcome> {
  const { args, environment, processEnvironment, readline, interactive, depth, keys, rates, watched, queuedInput, kittyImages, openClient, runTurn, openSettings, writeHint, currentBalance, persistManualBalance, criticalBalance, sessionSpend, startBackgroundJob, startWatching, bindSigint, unbindSigint } = context;
  const state = context.state;
  const wander = parseWanderCommand(input);
  if (wander) {
    if (wander.kind === "invalid") {
      out.write(style.yellow(`  ${wander.reason}\n`));
      return "continue";
    }
    if (wander.kind === "schedule") {
      // Recurring Wander is a durable job, not a turn: it has to survive this process exiting.
      // The first occurrence runs now; a completed one re-queues itself for the next, so one
      // detached worker process carries the whole schedule without needing a system cron entry.
      const id = newJobId();
      const objective = wanderJobObjective(wander);
      const job = await enqueueJob(args.root, { id, objective, logPath: jobLogPath(args.root, id), cadence: wander.cadence, runAt: Date.now(), modelSelection: state.model.selection });
      await spawnJobWorker(args.root, job.id);
      out.write(`  ${style.cyan("scheduled")} — job ${job.id} runs now, then every ${wander.cadence === "daily" ? "day" : "week"} after the last one finishes.\n`);
      out.write(style.dim(`  /attach ${job.id} to watch it · /jobs cancel ${job.id} to stop it\n`));
      return "continue";
    }

    // The lab may cite only what the dossier holds, and the agent may have no network at all, so
    // the search happens here — once, before the turn — and the result is written where the
    // protocol says the scout left it.
    out.write(`  ${style.cyan("wander")} ${style.dim(wander.random ? `picked: ${wander.topic}` : wander.topic)}\n`);
    const evidence = await gatherWanderEvidence(wander.topic, createExaClient(environment));
    if (evidence.expense) state.ledger.recordExpense(evidence.expense);
    await state.workspace.writeFile(WANDER_LAB_FILES.evidence, evidence.markdown);
    out.write(style.dim(`  ${evidence.hits.length} source${evidence.hits.length === 1 ? "" : "s"} → ${WANDER_LAB_FILES.evidence}\n`));
    input = buildWanderPrompt(wander.topic);
    state.wanderRunning = true;
  }

  const jobsCommand = parseJobsCommand(input);
  if (jobsCommand) {
    await runJobsCommand(jobsCommand, {
      listJobs: () => listJobs(args.root),
      getJob: (id) => getJob(args.root, id),
      cancelJob: (id) => cancelJob(args.root, id),
      resolveApproval: (id, decision, digest) => resolveJobApproval(args.root, id, decision, digest),
      startJob: startBackgroundJob,
      signalWorker: (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } },
      write: (text) => out.write(text),
      paint: { ...surfacePaint, yellow: style.yellow },
      glyphs,
      width: contentWidth(),
    });
    return "continue";
  }

  const detachCommand = parseDetachCommand(input);
  if (detachCommand) {
    if (detachCommand.kind === "invalid") {
      out.write(style.yellow(`  ${detachCommand.reason}\n`));
      return "continue";
    }
    const job = await startBackgroundJob(detachCommand.objective);
    out.write(`  ${style.cyan("started")} job ${job.id} in the background. /attach ${job.id} to watch it.\n`);
    return "continue";
  }

  if (input === "/watch" || input.startsWith("/watch ")) {
    await runWatchCommand(input.slice("/watch".length), {
      watched,
      getJob: (id) => getJob(args.root, id),
      startWatching,
      write: (text) => out.write(text),
      paint: style,
      style: sectionStyle(),
      glyphs,
    });
    return "continue";
  }

  const attachCommand = parseAttachCommand(input);
  if (attachCommand) {
    if (attachCommand.kind === "invalid") { out.write(style.yellow(`  ${attachCommand.reason}\n`)); return "continue"; }
    await runAttach(attachCommand.id, {
      getJob: (id) => getJob(args.root, id),
      readLog: (id, offset) => readJobLog(args.root, id, offset),
      resolveApproval: (id, decision, digest) => resolveJobApproval(args.root, id, decision, digest),
      isTerminal,
      describe: describeJobForHuman,
      ask: (question) => readline.question(question),
      takeInterrupt: (onInterrupt) => {
        unbindSigint();
        process.on("SIGINT", onInterrupt);
        readline.on("SIGINT", onInterrupt);
        return () => { process.off("SIGINT", onInterrupt); readline.off("SIGINT", onInterrupt); bindSigint(); };
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      write: (text) => out.write(text),
      paint: style,
    });
    return "continue";
  }

  if (input === "/keys") {
    out.write(`${keys.render()}\n\n${renderKeyboardShortcuts(state.language)}\n`);
    return "continue";
  }
  if (input === "/undo" || input.startsWith("/undo ")) {
    const argument = input.slice("/undo".length).trim();
    const scope = argument === "code" || argument === "conversation" ? argument : argument === "" ? "both" : null;
    if (scope === null) {
      out.write(style.yellow(`  /undo takes no argument, "code", or "conversation" — not "${argument}".\n`));
      return "continue";
    }
    const restored = await state.agent.undo(scope);
    const label = scope === "code" ? "reverted the files for" : scope === "conversation" ? "rewound the conversation before" : "reverted";
    out.write(restored ? style.green(`  ${label} "${restored.label}"\n`) : style.yellow("  nothing to undo\n"));
    return "continue";
  }
  if (input === "/clear") {
    if (kittyImages.length > 0) { process.stdout.write(clearKittyImages(kittyImages)); kittyImages.length = 0; }
    await state.agent.relinquish();
    state.agent = await openClient();
    // A new thread has neither the old thread's folded output nor its remembered context.
    expandables.clear();
    out.write(style.dim("  new thread\n"));
    return "continue";
  }
  if (input.startsWith("/pull")) {
    if (state.workspace.kind !== "e2b") { out.write(style.yellow("  already working locally — nothing to pull\n")); return "continue"; }
    const destination = path.resolve(args.root, input.split(/\s+/)[1] ?? "archymedes-pull");
    const pulled = await downloadProject(state.workspace, destination);
    out.write(style.green(`  pulled ${pulled.written.length} files into ${destination}\n`));
    if (pulled.failed.length > 0) out.write(style.yellow(`  ${pulled.failed.length} could not be read\n`));
    return "continue";
  }
  if (input === "/providers") {
    out.write(`${renderProviders(environment, depth)}\n`);
    return "continue";
  }
  if (input === "/settings") {
    if (await openSettings() === "exit") return "break";
    return "continue";
  }
  if (input === "/upgrade" || input === "/upgrades") {
    const upgraded = await runUpgradeCommand({
      // The status bar owns the bottom rows, so it steps aside for the
      // hidden prompt the same way every other inline question does.
      askSecret: async (question) => { statusBar.clear(); return hiddenQuestion(readline, question); },
      write: (text) => out.write(text),
      paint: style,
    }, {
      settings: state.savedSettings,
      save: async (next) => {
        const file = await saveSettings(next, processEnvironment);
        // The saved values have to reach the same merged view every
        // later read uses, or the key just typed is invisible here.
        state.savedSettings = next;
        for (const field of SETTING_FIELDS) delete environment[field.key];
        Object.assign(environment, mergedEnvironment(state.savedSettings, processEnvironment));
        return file;
      },
    });
    if ("saved" in upgraded) {
      // Carry the conversation onto the direct-key provider, the
      // same switch /model performs, so the rest of this session
      // runs on the key that was just saved.
      const attempt = resolveProvider(environment, { provider: "openrouter" });
      if (!("error" in attempt)) {
        state.model = attempt.provider;
        state.spec = attempt.spec;
        state.prices = attempt.prices;
        state.resolvedModelId = attempt.model;
        state.ledger.setPrices(state.prices);
        state.agent = await openClient(await state.agent.relinquish());
        out.write(style.dim(`  switched to ${attempt.spec.label} ${attempt.model}\n`));
      }
    }
    return "continue";
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
      if (decision === "n" || decision === "no") return "continue";
      if (decision === "e" || decision === "edit") transcript = (await readline.question("  Edit prompt: ")).trim() || transcript;
      await runTurn(transcript);
    } catch (error) {
      out.write(style.red(`  Voice input failed: ${error instanceof Error ? error.message : String(error)}\n`));
    } finally {
      if (temporary && audioFile) await removeRecording(audioFile).catch(() => undefined);
    }
    return "continue";
  }
  if (input === "/cost") {
    out.write(renderCostReport({ report: state.ledger.formatReport(), history: state.ledger.history, display: state.display, rates, paint: surfacePaint, glyphs, depth: renderDepth, width: contentWidth() }));
    const fraction = state.ledger.budgetFraction;
    if (fraction !== undefined) await animateBudgetMeter(fraction, { out, palette, depth: renderDepth, glyphs, dim: style.dim });
    return "continue";
  }
  if (input === "/update" || input.startsWith("/update ")) {
    await runUpdateCommand(input.slice("/update".length).trim().toLowerCase(), {
      currentVersion: ARCHYMEDES_CLI_VERSION,
      fetchLatest: () => fetchLatestVersion({ environment, timeoutMs: 10_000 }).catch(() => undefined),
      compareVersions,
      savePolicy: async (policy) => {
        const saved = await saveSettings({ ...await loadSettings(environment), ARCHYMEDES_AUTO_UPDATE: policy }, environment).then(() => true, () => false);
        environment.ARCHYMEDES_AUTO_UPDATE = policy;
        return saved;
      },
      confirm: async (question) => { statusBar.clear(); return ["y", "yes"].includes((await readline.question(`  ${style.yellow("?")} ${question} ${style.dim("[y/N]: ")}`)).trim().toLowerCase()); },
      // `yes` because the question above was the consent; the updater must not ask again on this terminal.
      runUpdate: (stdout, stderr) => runSelfUpdate({ yes: true, interactive: false, environment, stdout, stderr }),
      write: (text) => out.write(text),
      paint: style,
      glyphs,
    });
    return "continue";
  }

  const manualBalanceCommand = parseManualBalanceCommand(input);
  if (manualBalanceCommand) {
    const hosted = state.model as typeof state.model & { creditBalance?: (signal?: AbortSignal) => Promise<HostedCreditBalance | null> };
    await runBalanceCommand(manualBalanceCommand, {
      display: state.display,
      ...(typeof hosted.creditBalance === "function" ? { readHostedBalance: (signal: AbortSignal) => hosted.creditBalance!(signal) } : {}),
      onPendingRead: (controller) => { state.pendingReadAbort = controller; },
      currentBalance,
      persistBalance: persistManualBalance,
      criticalBalance,
      sessionSpend,
      now: Date.now,
      write: (text) => out.write(text),
      paint: style,
    });
    return "continue";
  }

  if (input === "/scan" || input.startsWith("/scan ")) {
    state.lastScanFindings = await runScan(input.slice("/scan".length).trim() || undefined, {
      scanSecrets: (include) => state.agent.scanSecrets(include),
      readWindow: (file, offset, limit) => state.agent.readFile(file, { offset, limit }).catch(() => null),
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
    return "continue";
  }
  if (input === "/where") {
    out.write(`  ${state.workspace.kind === "e2b" ? style.yellow(state.workspace.label) : style.dim(state.workspace.label)}\n`);
    return "continue";
  }
  if (input === "/diagnostics" || input.startsWith("/diagnostics ")) {
    await runDiagnosticsCommand(input.slice("/diagnostics".length).trim() || undefined, {
      collect: (include) => collectWorkspaceDiagnostics(args.root, include ? { include } : {}),
      write: (text) => out.write(text), paint: style, glyphs, depth: renderDepth, width: contentWidth(),
    });
    writeHint();
    return "continue";
  }
  if (input === "/tools") {
    const inspected = await state.agent.inspectTools();
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
    return "continue";
  }
  if (input.startsWith("/") && !isKnownCommand(input.split(/\s+/)[0])) {
    const prompt = await resolveSlashInput(input, { root: args.root, environment, dim: (text) => out.write(`${style.dim(text)}\n`), warn: (headline, detail) => out.write(`  ${style.yellow(headline)}${style.dim(detail)}\n`) });
    if (prompt === undefined) return "continue";
    input = prompt;
  }
  return { input };
}
