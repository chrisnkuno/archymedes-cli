/**
 * The invocations that answer and exit before any session exists: `--help`, `--version`,
 * `--gallery`, `--update`, `settings`, `--providers`, `--doctor`, `--sessions` and `history`.
 *
 * Moved out of `main()` unchanged. Each returns the process exit code when it handled the
 * invocation, and `undefined` when the invocation is an ordinary session that should carry on.
 */
import { createInterface } from "node:readline/promises";
import { listSessions, loadSession } from "@archymedes/core/cli/session";
import { PROVIDER_IDS, providerEnvPrefix, type ProviderId } from "@archymedes/core/providers/agent-matrix";
import { EXIT_CODES } from "../headless";
import { renderHistoryList, renderHistoryUsage, renderReplay, searchHistory, summarizeSession, type HistoryEntry } from "../commands/chat-history";
import { galleryVariants, renderGallery } from "../ui/gallery";
import { KeyBindingRegistry, escapeCodeTimeoutMs, parseBindingOverrides } from "../terminal/keybindings";
import { doctorExitCode, doctorReport, renderDoctor, runDoctor } from "../platform/doctor";
import { ARCHYMEDES_CLI_VERSION, runSelfUpdate } from "../platform/update";
import { runSettingsMenu, saveSettings, type ArchymedesSettings } from "../platform/settings";
import type { resolveControlLanguage } from "../platform/i18n";
import { builtinThemeChoices } from "../theme/theme";
import { detectColorDepth } from "../text/color-depth";
import { resolveGlyphs } from "../text/glyphs";
import { heading } from "../render/sections";
import type { CliStateHistory } from "../session/state-history";
import { deleteSession } from "../session/delete-session";
import type { ParsedArgs } from "./args";
import { helpText } from "./help";
import { hiddenQuestion, isReadlineExit, settingsChooser } from "./prompts";
import { modelChoicesForSettingsField, renderProviders } from "./providers";
import { glyphs, out, sectionStyle, style } from "./transcript";

type Environment = Record<string, string | undefined>;

export type StartupCommandContext = {
  args: ParsedArgs;
  environment: Environment;
  processEnvironment: Environment;
  language: ReturnType<typeof resolveControlLanguage>;
  earlyDepth: ReturnType<typeof detectColorDepth>;
  stateHistory: CliStateHistory;
  savedSettings: ArchymedesSettings;
};

/** `--help`, `--version` and `--gallery`: printed from the early rendering setup, before `--acp`. */
export function runInformationFlag(context: Pick<StartupCommandContext, "args" | "environment" | "language" | "earlyDepth">): number | undefined {
  const { args, environment, language, earlyDepth } = context;
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
  return undefined;
}

/** `--update`, `settings`, `--providers`, `--doctor`, `--sessions` and `history`, in that order. */
export async function runMaintenanceFlag(context: Omit<StartupCommandContext, "earlyDepth">): Promise<number | undefined> {
  const { args, environment, processEnvironment, language, stateHistory } = context;
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
    const settingsReadline = createInterface({ input: process.stdin, output: process.stdout, escapeCodeTimeout: escapeCodeTimeoutMs() });
    let savedSettings = context.savedSettings;
    try {
      savedSettings = await runSettingsMenu(savedSettings, {
        ask: (question) => settingsReadline.question(question),
        askSecret: (question) => hiddenQuestion(settingsReadline, question),
        write: (text) => process.stdout.write(text),
        choose: settingsChooser(settingsReadline),
      }, {
        modelChoices: (field, current) => modelChoicesForSettingsField(field, current, processEnvironment, "USD", []),
        themeChoices: builtinThemeChoices(),
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
      // The index is a cache; the snapshot is the authority on which project a chat belongs to.
      // loadSession refuses a record whose recorded root is not this one, so a chat copied in from
      // another project (or a stale index row) is never listed here.
      ? (await Promise.all(indexed.map(async (session) => (await loadSession(args.root, session.sessionId).catch(() => null))
        ? { id: session.sessionId, title: session.title, updatedAt: session.updatedAt ?? 0 }
        : null))).filter((session): session is { id: string; title: string; updatedAt: number } => session !== null)
      : await listSessions(args.root);
    if (sessions.length === 0) out.write("No sessions in this project yet.\n");
    for (const session of sessions) {
      out.write(`${style.cyan(session.id)}  ${new Date(session.updatedAt).toLocaleString()}  ${session.title}\n`);
    }
    await stateHistory.close();
    return 0;
  }

  if (args.historyCommand?.kind === "resume" && process.stdin.isTTY && process.stdout.isTTY) {
    // `archymedes history resume [id]` from a terminal starts the session it names — or, with no
    // id, the session picker — instead of printing a pointer to a different command.
    args.resume = args.historyCommand.id ?? "latest";
    args.resumePick = args.historyCommand.id === undefined;
    args.historyCommand = null;
    return undefined;
  }
  if (args.historyCommand) return runHistorySubcommand(args.historyCommand, args.root, stateHistory);
  return undefined;
}

/** `archymedes history [status|show|resume|search]`, outside any session. */
async function runHistorySubcommand(command: NonNullable<ParsedArgs["historyCommand"]>, root: string, stateHistory: CliStateHistory): Promise<number> {
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
    const record = await loadSession(root, command.id);
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
  if (command.kind === "delete") {
    // Everything-at-once is only offered inside a session, where it can ask first and keep the open chat.
    if (command.all || !command.id) {
      process.stderr.write("Run /history delete --all inside archymedes; it asks before deleting anything.\n");
      return EXIT_CODES.usage;
    }
    const outcome = await deleteSession(root, command.id);
    await stateHistory.close();
    if (!outcome.deleted) { process.stderr.write(`${outcome.reason}\n`); return EXIT_CODES.usage; }
    out.write(`Deleted ${command.id}.\n`);
    return 0;
  }

  const historyEntries = async (): Promise<HistoryEntry[]> => {
    const indexed = await stateHistory.sessions(30);
    const listed = indexed
      ? indexed.map((session) => ({ id: session.sessionId, title: session.title, updatedAt: session.updatedAt ?? 0 }))
      : await listSessions(root, 30);
    return (await Promise.all(listed.map(async (summary) => {
      const record = await loadSession(root, summary.id);
      return record ? summarizeSession(record) : null;
    }))).filter((entry): entry is HistoryEntry => entry !== null);
  };

  if (command.kind === "search") {
    const nativeHits = await stateHistory.search(command.query, 20);
    const found = nativeHits
      ? (await Promise.all(nativeHits.map(async (hit): Promise<HistoryEntry | null> => {
          const record = await loadSession(root, hit.sessionId);
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
