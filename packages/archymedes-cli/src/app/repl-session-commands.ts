/**
 * Slash commands that steer the session itself: the palette, `/exit`, `/help`, `/retry`,
 * `/continue`, `/fallback`, `/export`, `/mode`, `/model`, `/expand`, `/memory` and `/slow`.
 *
 * Moved out of the REPL loop unchanged; see `SlashOutcome` for what the result means.
 */
import { type ArchymedesMode } from "@archymedes/core/cli/permissions";
import { loadSession } from "@archymedes/core/cli/session";
import { providerEnvPrefix, resolveProvider } from "@archymedes/core/providers/agent-matrix";
import { parseModeCommand } from "../catalog/commands";
import { parseMemoryCommand } from "../commands/memory";
import { runMemoryCommand } from "../commands/memory-command";
import { chooseModel, rememberModelChoice } from "../commands/model";
import { describePace, parsePaceCommand } from "../commands/pacing";
import { saveSettings } from "../platform/settings";
import { parseExpandCommand, renderExpandableList } from "../render/expandable";
import { rule } from "../render/sections";
import { FALLBACK_PROVIDERS, fallbackSetting, parseFallbackPreference } from "../session/fallback";
import { parseModelCommand } from "../session/models";
import { type ExportFormat, exportSession } from "../session/session-export";
import { isSimpleMode, rankWithContext, renderGroupedHelp, renderSimpleHelp } from "../ui/navigation";
import { openChooser, openPalette } from "../ui/shortcuts";
import { WorkspaceFrame } from "../ui/workspace-frame";
import { contentWidth, expandables, glyphs, out, screen, sectionStyle, style, surfacePaint } from "./transcript";
import type { ReplContext, SlashOutcome } from "./repl-context";

export async function dispatchSessionCommand(input: string, context: ReplContext): Promise<SlashOutcome> {
  const { args, environment, processEnvironment, readline, interactive, depth, keys, rates, recoveryState, openClient, openSettings, navContext, refreshLiveModels, checkBalance } = context;
  const state = context.state;
  if (input === "/palette") {
    const chosen = interactive
      ? await openPalette({ readline, input: process.stdin, output: process.stdout, registry: keys }, undefined, {
          // Ranked against this session: the empty-query view is otherwise the catalog in
          // alphabetical order, which is the least useful thing a palette can open on.
          rank: (entries, query) => rankWithContext(entries, query, navContext()),
        })
      : undefined;
    if (!chosen?.trim()) return "continue";
    input = chosen.trim();
  }

  if (input === "/exit" || input === "/quit") return "break";
  if (input === "/help" || input.startsWith("/help ")) {
    // Grouped and filtered to what this session can actually use, with everything one keystroke
    // away. The flag reference stays on `archymedes --help`, where someone reading about invocation is
    // looking; inside a session it is thirty lines about starting a session you are already in.
    const requested = input.slice("/help".length).trim();
    const groupNames = ["work", "review", "steer", "parallel", "learn", "setup"] as const;
    if (requested && requested !== "all" && !groupNames.includes(requested as typeof groupNames[number])) {
      out.write(style.yellow("  Choose /help all, work, review, steer, parallel, learn, or setup.\n"));
      return "continue";
    }
    // Simple mode leads with the short list; /help all (or a group) is the full reference.
    if (!requested && isSimpleMode(context.environment)) {
      out.write(`${renderSimpleHelp(sectionStyle())}\n`);
      return "continue";
    }
    out.write(`${renderGroupedHelp(navContext(), sectionStyle(), {
      all: requested === "all" || Boolean(requested),
      ...(requested && requested !== "all" ? { group: requested as typeof groupNames[number] } : {}),
    })}\n`);
    return "continue";
  }
  if (input === "/retry") {
    const lastRecoverableTurn = recoveryState.last;
    if (!lastRecoverableTurn) {
      out.write(style.dim("  nothing to retry — no model request has failed in this session\n"));
      return "continue";
    }
    if (lastRecoverableTurn.status === "completed") {
      out.write(style.dim("  the last task completed — describe a new request, or use /continue only after an incomplete task\n"));
      return "continue";
    }
    if (lastRecoverableTurn.toolCalls > 0 || lastRecoverableTurn.changedFiles > 0) {
      out.write(style.yellow(`  retry refused — the last task already ran ${lastRecoverableTurn.toolCalls} tool${lastRecoverableTurn.toolCalls === 1 ? "" : "s"} and changed ${lastRecoverableTurn.changedFiles} file${lastRecoverableTurn.changedFiles === 1 ? "" : "s"}.\n`));
      out.write(style.dim("  Use /continue to inspect the current state and finish without repeating completed actions.\n"));
      return "continue";
    }
    out.write(style.dim("  retrying the unchanged request — no earlier tool or file action can be duplicated\n"));
    input = lastRecoverableTurn.request;
  }
  if (input === "/continue") {
    const lastRecoverableTurn = recoveryState.last;
    if (!lastRecoverableTurn) {
      out.write(style.dim("  nothing to continue — start a task first\n"));
      return "continue";
    }
    if (lastRecoverableTurn.status === "completed") {
      out.write(style.dim("  the last task is already complete\n"));
      return "continue";
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
      return "continue";
    }
    const preference = parseFallbackPreference(raw);
    if (!preference) {
      out.write(style.yellow(`  Choose /fallback off, /fallback ask, or /fallback provider:model (providers: ${FALLBACK_PROVIDERS.join(", ")}).\n`));
      return "continue";
    }
    const value = fallbackSetting(preference);
    state.savedSettings = { ...state.savedSettings };
    if (value) state.savedSettings.ARCHYMEDES_FALLBACK_MODEL = value;
    else delete state.savedSettings.ARCHYMEDES_FALLBACK_MODEL;
    try {
      await saveSettings(state.savedSettings, processEnvironment);
      if (value) environment.ARCHYMEDES_FALLBACK_MODEL = value;
      else delete environment.ARCHYMEDES_FALLBACK_MODEL;
      out.write(style.dim(`  provider fallback ${preference.kind === "off" ? "disabled" : `set to ${value}`} · saved\n`));
    } catch (error) {
      out.write(style.yellow(`  Could not save fallback setting: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    return "continue";
  }
  if (input === "/export" || input.startsWith("/export ")) {
    const format = (input.slice("/export".length).trim() || "markdown") as ExportFormat;
    if (!["markdown", "json", "support"].includes(format)) {
      out.write(style.yellow("  Choose /export markdown, /export json, or /export support.\n"));
      return "continue";
    }
    const record = await loadSession(args.root, state.agent.sessionId);
    if (!record) {
      out.write(style.yellow("  This session has not produced a saved turn yet.\n"));
      return "continue";
    }
    try {
      const file = await exportSession(record, format);
      out.write(style.dim(`  redacted ${format} export written to ${file}\n`));
    } catch (error) {
      out.write(style.yellow(`  Could not export the session: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    return "continue";
  }
  if (input === "/mode" && screen instanceof WorkspaceFrame) {
    const modes = ["plan", "build", "auto", "defender"] as const;
    const descriptions = ["Read and reason; no changes", "Edit with your approval", "Apply ordinary changes automatically", "Security review; fixes require approval"];
    const chosen = await openChooser({ readline, input: process.stdin, output: process.stdout },
      modes.map((value, i) => ({ value, label: value, description: descriptions[i], hint: value === state.mode ? "current" : undefined })),
      { title: "Choose how Archymedes works", initialIndex: modes.indexOf(state.mode), paint: surfacePaint, glyphs });
    if (!chosen) return "continue";
    input = `/mode ${chosen}`;
  }
  const modeCommand = parseModeCommand(input);
  if (modeCommand?.type === "show") {
    const posture = state.mode === "plan" ? "read-only; write and command tools are unavailable" : state.mode === "build" ? "workspace changes ask for approval" : state.mode === "defender" ? "security review; every change still asks for approval" : "ordinary workspace changes are pre-approved; sensitive and external actions still ask";
    out.write(`  ${style.cyan(state.mode)} · ${style.dim(posture)}\n`);
    return "continue";
  }
  if (modeCommand?.type === "invalid") {
    out.write(style.yellow("  Choose /mode plan, /mode build, /mode auto, or /mode defender.\n"));
    return "continue";
  }
  if (modeCommand?.type === "switch") {
    const requestedMode: ArchymedesMode = modeCommand.mode;
    if (requestedMode === state.mode) {
      out.write(style.dim(`  already in ${state.mode} mode\n`));
      return "continue";
    }
    state.mode = requestedMode;
    // A new mode is a new permission posture; the transcript carries over so the plan the agent
    // just produced is still in context when it starts building — Cline's behaviour, and the
    // reason Plan mode is useful rather than a separate conversation.
    const previous = state.agent;
    // Relinquishing returns the live transcript atomically, before retiring the old client.
    const carried = await previous.relinquish();
    state.agent = await openClient(carried);
    const posture = state.mode === "plan" ? "read-only; no write tools" : state.mode === "build" ? "edits and commands require approval" : state.mode === "defender" ? "security review; every fix still requires approval" : "ordinary edits and commands are pre-approved; sensitive and external actions require approval";
    out.write(style.dim(`  switched to ${state.mode} mode · ${posture}\n`));
    return "continue";
  }
  const modelCommand = parseModelCommand(input);
  if (modelCommand) {
    const target = await chooseModel(modelCommand, {
      environment,
      liveModels: () => state.liveModels,
      refreshLiveModels,
      current: { provider: state.spec.id, model: state.resolvedModelId },
      display: state.display,
      rates,
      ...(interactive ? { host: { readline, input: process.stdin, output: process.stdout } } : {}),
      write: (text) => out.write(text),
      paint: { ...surfacePaint, yellow: style.yellow, dim: style.dim },
      glyphs,
      width: contentWidth(),
    });
    if (target.kind === "settings") { if (await openSettings("providers") === "exit") return "break"; return "continue"; }
    if (target.kind === "none") return "continue";
    const attempt = resolveProvider(environment, { provider: target.provider, model: target.model });
    if ("error" in attempt) { out.write(`${style.red(attempt.error)}\n`); return "continue"; }
    if (attempt.spec.id === state.spec.id && attempt.model === state.resolvedModelId) {
      out.write(style.dim(`  already on ${state.spec.label} ${state.resolvedModelId}\n`));
      return "continue";
    }
    state.model = attempt.provider;
    state.spec = attempt.spec;
    state.prices = attempt.prices;
    state.resolvedModelId = attempt.model;
    state.ledger.setPrices(state.prices);
    state.agent = await openClient(await state.agent.relinquish());
    await checkBalance(true);
    const remembered = await rememberModelChoice(state.savedSettings, { id: state.spec.id, envPrefix: providerEnvPrefix(state.spec.id) }, state.resolvedModelId, processEnvironment, saveSettings);
    state.savedSettings = remembered.settings;
    if (remembered.environment) Object.assign(environment, remembered.environment);
    out.write(style.dim(`  switched to ${state.spec.label} ${state.resolvedModelId}${state.prices ? "" : " — no price configured, costs will show as unknown"}${remembered.note}\n`));
    return "continue";
  }
  const expandCommand = parseExpandCommand(input);
  if (expandCommand) {
    if (expandCommand.kind === "invalid") { out.write(style.yellow(`  ${expandCommand.reason}\n`)); return "continue"; }
    if (expandCommand.kind === "list") { out.write(`${renderExpandableList(expandables.all, depth, glyphs)}\n`); return "continue"; }
    const chosen = expandCommand.kind === "one"
      ? [expandables.get(expandCommand.id)]
      : expandCommand.kind === "all" ? [...expandables.all] : [expandables.last];
    const found = chosen.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    if (found.length === 0) {
      out.write(style.dim(`  nothing to expand${expandCommand.kind === "one" ? ` as ${expandCommand.id}` : ""} — /expand list shows what is folded\n`));
      return "continue";
    }
    for (const entry of found) {
      out.write(`${rule(sectionStyle(), { label: entry.label, tone: "accent" })}\n`);
      out.write(`${entry.full}\n`);
    }
    return "continue";
  }

  const memoryCommand = parseMemoryCommand(input);
  if (memoryCommand) {
    await runMemoryCommand(memoryCommand, {
      root: args.root,
      environment,
      memories: state.memories,
      setMemories: (entries) => { state.memories = entries; },
      confirm: async (question) => ["y", "yes"].includes((await readline.question(`  ${style.yellow("?")} ${question} ${style.dim("[y/N]: ")}`)).trim().toLowerCase()),
      write: (text) => out.write(text),
      paint: style,
      style: sectionStyle(),
      glyphs,
    });
    return "continue";
  }

  const paceCommand = parsePaceCommand(input, state.pace);
  if (paceCommand) {
    if (paceCommand.kind === "invalid") { out.write(style.yellow(`  ${paceCommand.reason}\n`)); return "continue"; }
    if (paceCommand.kind === "show") { out.write(`${describePace(state.pace, sectionStyle())}\n`); return "continue"; }
    state.pace = paceCommand.level;
    // The pace lives in the agent's budgets, which are fixed when the client is built — so the
    // client is rebuilt around the same session, exactly as a mode or model switch does.
    const previous = state.agent;
    const carried = await previous.relinquish();
    state.agent = await openClient(carried);
    out.write(`${describePace(state.pace, sectionStyle())}\n`);
    return "continue";
  }
  return { input };
}
