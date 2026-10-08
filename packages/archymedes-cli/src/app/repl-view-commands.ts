/**
 * Slash commands that look at the session and its files: `/workspace`, `/guide`, `/files`,
 * `/edit`, `/find`, `/pager`, `/cat`, `/theme`, `/history`, `/todos`, `/task`, `/route`, `/diff`
 * and `/tab`.
 *
 * Moved out of the REPL loop unchanged; see `SlashOutcome` for what the result means.
 */
import { LocalWorkspace } from "@archymedes/core/cli/backends";
import { CostLedger } from "@archymedes/core/cli/cost";
import { listSessions, loadSession } from "@archymedes/core/cli/session";
import { resolveProvider } from "@archymedes/core/providers/agent-matrix";
import { PRICE_CATALOG } from "@archymedes/core/providers/price-catalog";
import { runCat } from "../commands/cat";
import { parseHistoryCommand } from "../commands/chat-history";
import { describeFind, parseFindCommand } from "../commands/find";
import { runGuideCommand } from "../commands/guide-command";
import { runHistoryCommand } from "../commands/history";
import { runPager } from "../commands/pager";
import { runRoutePlanCommand } from "../commands/route-plan";
import { type InspectContext, renderTask, renderTodos } from "../commands/session-inspect";
import { runTabCommand } from "../commands/tab";
import { runThemeCommand } from "../commands/theme-command";
import { saveSettings } from "../platform/settings";
import { deleteAllSessions, deleteSession } from "../session/delete-session";
import { expandHint } from "../render/expandable";
import { parseGuideCommand } from "../render/guide";
import { imagePreference } from "../render/image-view";
import { renderPatch, widestRow } from "../render/patch-view";
import { renderRoutingPlan } from "../render/routing-plan";
import { renderRoutingReceipt, renderRoutingSummary } from "../render/routing-receipt";
import { GUTTER } from "../render/sections";
import { box } from "../render/tui";
import { describeLocation } from "../session/location";
import { parseTabCommand } from "../session/tabs";
import { TabSink } from "../terminal/output";
import { explainScreenRefusal, withFullScreen } from "../terminal/screen-host";
import { parseThemeCommand } from "../theme/theme";
import { discoverThemes, findTheme, themeDirectory } from "../theme/theme-files";
import { openChooser } from "../ui/shortcuts";
import { WorkspaceFrame } from "../ui/workspace-frame";
import { buildWorkspaceSnapshot, PaneActivity } from "../ui/workspace-model";
import { describeTab } from "./tab-switching";
import { contentWidth, expandables, FOLD_AFTER_LINES, glyphs, out, palette, renderDepth, screen, sectionStyle, sessionChecks, sessionFiles, sessionStream, style, writeFoldable } from "./transcript";
import type { ReplContext, SlashOutcome } from "./repl-context";

export async function dispatchViewCommand(input: string, context: ReplContext): Promise<SlashOutcome> {
  const { args, environment, readline, rl, interactive, depth, rates, approvedBudget, tabs, watched, stateHistory, kittyImages, openClient, createWorkspace, editFile, writeHint, screenCapabilities, terminalControls, applyTheme, carryResumedSpend, stashActiveTab, enterTab, switchTab, showTabs } = context;
  const state = context.state;
  if (input === "/workspace" || input === "/panel") {
    // A read-only view of every tab and watched job; activity samples only mean something while it is open.
    const activity = new PaneActivity();
    const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
      const { runWorkspace } = await import("../ui/workspace-screen");
      await runWorkspace({
        read: () => buildWorkspaceSnapshot({
          views: tabs.views(describeTab),
          linesFor: (id) => { const held = tabs.find(id); return { lines: held?.payload.sink.log.lines ?? [], dropped: held?.payload.sink.log.dropped ?? 0 }; },
          jobs: watched.all.map((job) => ({ id: job.stream.id, objective: job.objective, done: job.stream.done, lines: job.sink.log.lines, dropped: job.sink.log.dropped })),
          activity,
          palette,
          columns: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
        }),
      });
    });
    // No text path: several live panes is the thing a transcript cannot express.
    if (!outcome.ok) out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`));
    return "continue";
  }

  const guideCommand = parseGuideCommand(input);
  if (guideCommand) {
    await runGuideCommand(guideCommand, {
      // A `false` means the printed guide is the right answer: a pipe, a small window, or a pruned build.
      openScreen: async () => (await withFullScreen(screenCapabilities(), terminalControls(), async () => {
        const { runGuideScreen } = await import("../ui/guide-screen");
        await runGuideScreen({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24, palette });
      })).ok,
      fold: (label, text, hidden) => expandables.add(label, text, hidden),
      foldAfterLines: FOLD_AFTER_LINES,
      write: (text) => out.write(text),
      paint: style,
      style: sectionStyle(),
      glyphs,
      depth: renderDepth,
    });
    return "continue";
  }

  if (input === "/files") {
    // The flat list already loaded for `@path` completion — opening the picker costs nothing
    // beyond what a session already pays for that, and the two now agree on exactly which files
    // are reachable.
    let picked: { path: string; intent: "mention" | "edit" } | undefined;
    const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
      const { runFileScreen } = await import("../ui/file-screen");
      picked = await runFileScreen({
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        paths: state.projectFiles,
        palette,
        readFile: async (path) => {
          const result = await state.workspace.readFile(path, { limit: 200 });
          return { content: result.content, totalLines: result.totalLines, truncated: result.truncated };
        },
      });
    });
    if (!outcome.ok) { out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`)); return "continue"; }
    if (picked?.intent === "edit") { await editFile(picked.path); return "continue"; }
    // Picking a file writes an `@path` mention into the line still being composed — the same
    // syntax typing `@` and tab-completing already produces, so the model sees one convention
    // for "this file", not two.
    if (picked) rl.write(`@${picked.path} `);
    return "continue";
  }

  if (input === "/edit" || input.startsWith("/edit ")) {
    const target = input.slice("/edit".length).trim();
    if (!target) { out.write(style.yellow("  Usage: /edit <path>, or press e on a file in /files.\n")); return "continue"; }
    await editFile(target);
    return "continue";
  }

  const findRequest = parseFindCommand(input);
  if (findRequest) {
    const message = describeFind(screen instanceof WorkspaceFrame ? screen.find(findRequest) : undefined);
    if (message) out.write(style.dim(`  ${message}\n`));
    return "continue";
  }

  if (input === "/pager") {
    const log = tabs.active.payload.sink.log;
    let pager: { opened: boolean; reason?: string } = { opened: false };
    const internal = async (text: string) => {
      const { runPagerScreen } = await import("../ui/pager-screen");
      await runPagerScreen({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24, text, title: "transcript" });
    };
    // `less` gives no hint of its own about how to leave it; said once, before it takes the screen.
    if (process.platform !== "win32" || environment.PAGER?.trim()) out.write(style.dim("  opening the pager — press q to come back\n"));
    const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => { pager = await runPager(log, environment, undefined, { internal }); });
    if (!outcome.ok) out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`));
    else if (!pager.opened && pager.reason) out.write(style.yellow(`  ${pager.reason}\n`));
    return "continue";
  }

  if (input === "/cat" || input.startsWith("/cat ")) {
    await runCat(input.slice("/cat".length).trim(), {
      readFile: (target) => state.workspace.readFile(target, {}),
      ...(state.workspace instanceof LocalWorkspace ? { readBytes: (target: string) => (state.workspace as LocalWorkspace).readBytes(target) } : {}),
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
    return "continue";
  }

  const themeCommand = parseThemeCommand(input);
  if (themeCommand) {
    await runThemeCommand(themeCommand, {
      discover: () => discoverThemes(args.root, environment),
      find: (name) => findTheme(name, args.root, environment),
      directory: (scope) => themeDirectory(scope, args.root, environment),
      active: { name: state.themeName, ...(state.activeTheme?.description ? { description: state.activeTheme.description } : {}) },
      apply: (theme) => {
        state.activeTheme = theme as typeof state.activeTheme;
        applyTheme(theme);
        // Remembered: a theme picked once should still be the theme tomorrow. Saved the same way
        // /settings saves, so the two never disagree about what ARCHYMEDES_THEME is.
        state.savedSettings = { ...state.savedSettings, ARCHYMEDES_THEME: theme.name };
        environment.ARCHYMEDES_THEME = context.processEnvironment.ARCHYMEDES_THEME ?? theme.name;
        void saveSettings(state.savedSettings, context.processEnvironment).then(
          () => out.write(style.dim(`  ${theme.name} is now your default theme (saved in settings).\n`)),
          (error: unknown) => out.write(style.yellow(`  Theme applied, but could not be saved: ${error instanceof Error ? error.message : String(error)}\n`)),
        );
      },
      write: (text) => out.write(text),
      paint: () => style,
      style: sectionStyle,
      glyphs,
      width: contentWidth(),
      ...(interactive ? {
        choose: (items, initialIndex) => openChooser<string>({ readline, input: process.stdin, output: process.stdout }, items, {
          title: "Theme — colours for the whole CLI", filter: true, height: 12, initialIndex, glyphs,
          paint: { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow },
        }),
      } : {}),
    });
    return "continue";
  }

  const historyCommand = parseHistoryCommand(input);
  if (historyCommand) {
    await runHistoryCommand(historyCommand, {
      stateHistory,
      listSessions: (limit) => listSessions(args.root, limit),
      loadSession: (id) => loadSession(args.root, id),
      currentSessionId: state.agent.sessionId,
      ...(interactive ? {
        choose: (items, extras) => openChooser<string>({ readline, input: process.stdin, output: process.stdout }, items,
          {
            title: "Pick up a past conversation", filter: true, height: 12, glyphs, paint: { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow },
            ...(extras?.onDelete ? { onDelete: extras.onDelete } : {}),
            ...(extras?.legend ? { legend: extras.legend } : {}),
          }),
        confirm: async (question: string) => ["y", "yes"].includes((await readline.question(`  ${style.yellow("?")} ${question} ${style.dim("[y/N]: ")}`)).trim().toLowerCase()),
      } : {}),
      // Only this project's own chats, and never the one that is open. The native index is told it
      // is stale so a deleted chat cannot come back in a list or a search.
      remove: async (id: string) => {
        const outcome = await deleteSession(args.root, id, { activeId: state.agent.sessionId });
        if (outcome.deleted) stateHistory.markDirty();
        return outcome;
      },
      removeAll: async () => {
        const outcome = await deleteAllSessions(args.root, { activeId: state.agent.sessionId });
        if (outcome.deleted > 0) stateHistory.markDirty();
        return outcome;
      },
      resume: async (record) => {
        await state.agent.relinquish();
        if (record.mode) state.mode = record.mode;
        state.agent = await openClient(record);
        await carryResumedSpend(state.agent.snapshot());
        expandables.clear();
      },
      write: (text) => out.write(text),
      paint: style,
      style: sectionStyle(),
      glyphs,
    });
    return "continue";
  }

  if (input === "/todos" || input === "/task") {
    // The two read-only "where do things stand" commands, rendered by `session-inspect.ts` from
    // an explicit snapshot rather than from this loop's locals — the first handler extraction.
    const inspect: InspectContext = {
      style: sectionStyle(),
      glyphs,
      depth,
      plan: state.agent.todos,
      request: state.sessionRequest,
      files: [...sessionFiles],
      checks: [...sessionChecks],
      lastTurnStatus: state.lastTurnStatus,
      turnsTaken: state.sessionRequest !== undefined,
    };
    if (input === "/todos") {
      const todos = renderTodos(inspect);
      if (todos === null) { out.write(style.dim("  no plan yet\n")); writeHint(); return "continue"; }
      out.write(`${todos}\n`);
      return "continue";
    }
    out.write(`${renderTask(inspect)}\n`);
    writeHint();
    return "continue";
  }
  if (input === "/route plan" || input.startsWith("/route plan ")) {
    await runRoutePlanCommand(input.slice("/route plan".length).trim(), {
      plan: (objective, signal) => state.agent.planRoute(objective, signal),
      onPendingRead: (controller) => { state.pendingReadAbort = controller; },
      render: (plan) => renderRoutingPlan(plan, sectionStyle()),
      write: (text) => out.write(text),
      dim: style.dim,
    });
    writeHint();
    return "continue";
  }
  if (input === "/route" || input === "/route all" || input === "/route summary") {
    const sessionReceipts = state.agent.routingReceipts;
    if (sessionReceipts.length === 0) {
      out.write(style.dim("  no hosted routing this session — /route needs the archymedes-cloud provider\n"));
      writeHint();
      return "continue";
    }
    if (input === "/route summary") {
      out.write(`${renderRoutingSummary(sessionReceipts, sectionStyle())}\n`);
      writeHint();
      return "continue";
    }
    const shown = input === "/route all" ? sessionReceipts : sessionReceipts.slice(-1);
    for (const [index, receipt] of shown.entries()) {
      out.write(`${renderRoutingReceipt(receipt, sectionStyle())}\n`);
      if (index < shown.length - 1) out.write("\n");
    }
    writeHint();
    return "continue";
  }
  if (input === "/diff" || input === "/diff stat") {
    // The stat is still one word away, because "how much changed" is a real question — it is
    // just not the one `/diff` was being asked.
    if (input === "/diff stat") {
      const stat = await state.agent.diffStat();
      if (stat) out.write(`${box(stat.split("\n"), { depth, title: "diff", glyphs, palette })}\n`);
      else { out.write(style.dim("  nothing changed since the last checkpoint\n")); writeHint(); }
      return "continue";
    }
    const patch = await state.agent.diffPatch();
    if (!patch.trim()) { out.write(style.dim("  nothing changed since the last checkpoint\n")); writeHint(); return "continue"; }
    const rendered = renderPatch(patch, sectionStyle(), { maxLinesPerFile: FOLD_AFTER_LINES * 2 });
    out.write(`${rendered.text}\n`);
    if (widestRow(rendered.text) > contentWidth()) out.write(style.dim("  some lines are wider than this window — /pager shows them unwrapped\n"));
    // The whole patch stays addressable: a folded file is the common case on a real change, and
    // the alternative — printing four hundred lines at someone — is why people stop typing /diff.
    const hiddenLines = patch.split("\n").length;
    const id = expandables.add("diff", renderPatch(patch, sectionStyle()).text, hiddenLines);
    out.write(`${GUTTER}${expandHint(id, hiddenLines, renderDepth, glyphs)}\n`);
    return "continue";
  }
  const tabCommand = parseTabCommand(input);
  if (tabCommand) {
    await runTabCommand(tabCommand, {
      tabs,
      resolve: (request) => resolveProvider(environment, request),
      sessionWorkspace: state.workspace,
      startWorkspace: (backend) => createWorkspace({ backend }),
      openTab: async (title, wanted, tabWorkspace, backend) => {
        // Opened before tabs.open(): WorkspaceController's factory is synchronous.
        const client = await openClient(undefined, { provider: wanted.provider, prices: wanted.prices, workspace: tabWorkspace });
        return tabs.open(title, () => ({
          agent: client,
          ledger: new CostLedger({ prices: wanted.prices, display: state.display, rates, catalog: PRICE_CATALOG, ...(approvedBudget ? { budget: approvedBudget } : {}) }),
          mode: state.mode,
          sink: new TabSink(sessionStream),
          provider: wanted.provider,
          spec: wanted.spec,
          prices: wanted.prices,
          modelId: wanted.model,
          backend: backend ?? args.backend,
          workspace: tabWorkspace,
          ownsWorkspace: tabWorkspace !== state.workspace,
        }));
      },
      stashActiveTab,
      enterTab,
      switchTab,
      showTabs,
      describeLocation,
      firstTabExplanation: () => !state.explainedTabs && (state.explainedTabs = true),
      write: (text) => out.write(text),
      paint: style,
      glyphs,
    });
    return "continue";
  }
  return { input };
}
