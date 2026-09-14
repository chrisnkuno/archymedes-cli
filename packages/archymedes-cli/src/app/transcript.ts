import path from "node:path";
import { type ArchymedesEvent } from "@archymedes/core/cli/agent";
import { detectColorDepth } from "../text/color-depth";
import { WorkspaceFrame } from "../ui/workspace-frame";
import { box, MarkdownStream, ReplaceableBlock, Spinner, StatusBar, table, wrapPlain } from "../render/tui";
import { PinnedScreen } from "../terminal/screen";
import { describeToolCall, summarizeToolResult } from "../render/transcript";
import { OutputRouter, terminalStream } from "../terminal/output";
import { RESET } from "../text/ansi";
import { ANSI_PALETTE, EXTERNAL_MARK, NO_COLOR_PALETTE, type Palette } from "../theme/theme";
import { UNICODE_GLYPHS, type GlyphSet } from "../text/glyphs";
import { GUTTER, panel, rule, type SectionStyle } from "../render/sections";
import { diffLines, diffStat, renderFileChange } from "../render/code-view";
import { parseTestOutput, renderTestReport } from "../render/test-report";
import { ExpandableStore, expandHint } from "../render/expandable";


/**
 * The transcript renderer's session state: colour switches and the themed `style`, the output
 * router, status bar and markdown stream, per-turn and per-session tallies, and `renderEvent`.
 * `main()` writes to this state only through `configureRendering`, `beginTranscriptTurn`,
 * `setSpinner` and `setScreen`.
 */

/**
 * Whether output is going somewhere that can render colour and be drawn on.
 *
 * `banner.ts` has always honoured this and `style` never did, so piping Archymedes's output still wrote
 * escape codes into whatever was reading it. Both now answer to the same switch.
 */
export let colorEnabled = false;
export let liveTerminal = false;

const wrap = (code: string) => (value: string) => (colorEnabled ? `${code}${value}${RESET}` : value);

/**
 * The palette in force. Replaced whenever a theme is chosen, which is why `role` below reads it
 * through a getter rather than closing over a code: a `/theme` typed mid-session has to change the
 * next line printed, not the next session started.
 */
export let palette: Palette = NO_COLOR_PALETTE;
const role = (pick: () => string, fallback: string) => (value: string) => {
  if (!colorEnabled) return value;
  return `${pick() || fallback}${value}${RESET}`;
};

/**
 * Colour, by the job it does.
 *
 * The four colour names are kept as they were — a hundred and fifty call sites say `style.cyan` —
 * but each now resolves through the theme's corresponding *role*, which is what lets a theme change
 * the whole transcript without any of those call sites being touched. `dim` and `bold` stay literal:
 * they are weights, not colours, and a theme that recoloured them would give Archymedes's subordinate text
 * a second voice competing with its first.
 */
export const style = {
  dim: wrap("\x1b[2m"),
  bold: wrap("\x1b[1m"),
  // Not themed: the "this call leaves the sandbox" mark is a rare, informational blast-radius
  // signal, not part of the transcript's usual colour vocabulary a theme should be free to recolour.
  magenta: wrap(EXTERNAL_MARK),
  cyan: role(() => palette.primary, ANSI_PALETTE.primary),
  green: role(() => palette.success, ANSI_PALETTE.success),
  yellow: role(() => palette.warning, ANSI_PALETTE.warning),
  red: role(() => palette.error, ANSI_PALETTE.error),
  accent: role(() => palette.accent, ANSI_PALETTE.accent),
};

/**
 * The four colours and one weight every menu, list and table renderer is handed.
 *
 * Named once here because three surfaces now want the same object and each was building its own
 * literal — and a renderer given `bold` by one caller and not another paints its selected row
 * differently on two screens for no reason a reader could discover.
 */
export const surfacePaint = { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow, bold: style.bold };

/**
 * Every line this file prints, addressed to a sink rather than to the process.
 *
 * The renderers below are module state because there is one screen; `out` is module state for the
 * same reason and one more: it is the seam that makes a second piece of work *possible*. Until the
 * writes went through here, a tab that was not in front had nowhere to put its output except on top
 * of the tab that was — which is why `tabs.ts` had to call itself sequential. Re-pointing this once
 * per tab switch is the whole of the mechanism.
 *
 * `statusBar`, `spinner` and `screen` are deliberately *not* routed: they are the pinned furniture
 * of the terminal itself — one status bar, one spinner, describing whatever is in front — rather
 * than transcript content belonging to a piece of work.
 */
export const out = new OutputRouter(terminalStream);
export const statusBar = new StatusBar();
export const toolLines = new ReplaceableBlock(out);
export let markdown = new MarkdownStream(out, "none");
export let spinner: Spinner | undefined;
export let screen: PinnedScreen | undefined;
export const sessionStream = {
  write: (text: string) => screen instanceof WorkspaceFrame ? screen.write(text) : terminalStream.write(text),
  get columns() { return process.stdout.columns; },
  get rows() { return process.stdout.rows; },
};
/**
 * The characters and the colour depth this terminal was found to support.
 *
 * Module state for the same reason `markdown` and `statusBar` are: there is one screen, and a
 * renderer that has to be told what it can draw at every call site is a renderer where one call
 * site will eventually be told wrong. `configureRendering` sets both from the environment once.
 */
export let glyphs: GlyphSet = UNICODE_GLYPHS;
export let renderDepth: ReturnType<typeof detectColorDepth> = "none";
/** Folded blocks from this session, addressable by `/expand`. */
export const expandables = new ExpandableStore();

/** Wrapping width for prose: the pinned screen's golden-ratio-capped measure, or the raw terminal otherwise. */
export function contentWidth(): number {
  return screen?.current.contentWidth ?? (process.stdout.columns ?? 80);
}
export const activity: { awaitingFirstDelta: boolean; toolCalls: number; tokens: number; phase: "thinking" | "operation"; operation?: string; steps?: { done: number; total: number; label?: string } } = {
  awaitingFirstDelta: false,
  toolCalls: 0,
  tokens: 0,
  phase: "thinking",
};
/**
 * Announced calls awaiting their result, by call id, so each can be rewritten where it sits.
 *
 * The arguments are held alongside the line handle because the *result* is where the transcript
 * shows what a write actually contained — by then the call event is long gone, and re-reading the
 * file to find out would be both a round trip and a different answer.
 */
const pendingCalls = new Map<string, {
  line: number;
  detail: string;
  name: string;
  arguments: Record<string, unknown>;
  effect: "none" | "workspace" | "external";
  /** Part of a batch fired while another call was still open — drawn with a connecting bar. */
  lane: boolean;
}>();
/** Paths successfully written or edited this turn, for the "files modified" footer. */
export let touchedFiles = new Set<string>();
/** Exact line delta across this turn's edits and writes, for the completion card scoreboard. */
export let turnLineDelta = { added: 0, removed: 0 };
/** Latest outcome for each verification class observed in this turn. */
export let verificationChecks = new Map<string, boolean>();
/**
 * Session-cumulative view for `/task` — per-file line deltas and the latest outcome per check
 * class, across every turn. Mutated in place and never reassigned, so the per-turn reset above
 * leaves them alone; they run for the life of one `main()`.
 */
export const sessionFiles = new Map<string, { added: number; removed: number }>();
export const sessionChecks = new Map<string, boolean>();
/** One labelled tool section per turn, so operational logs do not blend into the answer. */
export let toolSectionAnnounced = false;

/** Points the renderer at the colour depth, glyph repertoire and terminal the session actually has. */
export function configureRendering(
  depth: ReturnType<typeof detectColorDepth>,
  live: boolean = Boolean(process.stdout.isTTY),
  glyphSet: GlyphSet = UNICODE_GLYPHS,
  themePalette: Palette = NO_COLOR_PALETTE,
): void {
  colorEnabled = depth !== "none";
  liveTerminal = live;
  glyphs = glyphSet;
  renderDepth = depth;
  palette = themePalette;
  markdown = new MarkdownStream(out, depth, contentWidth, live, glyphSet, themePalette);
  toolSectionAnnounced = false;
  activity.awaitingFirstDelta = false;
  activity.toolCalls = 0;
  activity.tokens = 0;
  activity.phase = "thinking";
  activity.operation = undefined;
  activity.steps = undefined;
  touchedFiles = new Set();
  turnLineDelta = { added: 0, removed: 0 };
  forgetToolLines();
}

/** The width/depth/glyph triple every section renderer takes, from the live terminal. */
export function sectionStyle(): SectionStyle {
  return { width: contentWidth(), depth: renderDepth, glyphs, palette };
}

export function endStreamedLine(): void {
  markdown.end();
}

/** Drops the block and the calls it held, once something else owns the bottom of the screen. */
export function forgetToolLines(): void {
  toolLines.forget();
  pendingCalls.clear();
}

/**
 * Composes one tool line: a mark, the tool's blast-radius glyph, the tool, what it was called
 * with, and how it went. `lane` swaps the two-space indent for a connecting bar when this call is
 * part of a batch fired concurrently with others still in flight, so the batch reads as one group
 * of lanes rather than a coincidence of adjacent lines.
 */
function toolLineText(mark: string, name: string, detail: string, summary: string, effect: "none" | "workspace" | "external", lane: boolean): string {
  const indent = lane ? style.dim(glyphs.boxVertical) : " ";
  const effectGlyph = effect === "workspace" ? style.yellow(glyphs.effectWorkspace) : effect === "external" ? style.magenta(glyphs.effectExternal) : "";
  const head = `${indent} ${mark}${effectGlyph ? ` ${effectGlyph}` : ""} ${style.cyan(name)}`;
  const middle = detail ? `  ${detail}` : "";
  const tail = summary ? style.dim(` · ${summary}`) : "";
  return `${head}${middle}${tail}`;
}

/**
 * The user's own request, once it stops being typed and starts being a turn.
 *
 * Only called for text that actually becomes a turn — a slash command is a UI action, not a
 * message, the same distinction a real chat client draws by never bubbling `/mute` into the log as
 * if someone had said it aloud. Once the pinned footer owns the input row (see `screen` above), this
 * is the *only* place the user's own words reach the transcript at all: readline's echo now lands on
 * a row that gets cleared for the next prompt, not one that scrolls into history.
 *
 * Drawn as a bubble titled "you", matching the input bar it was typed into, so the transcript reads
 * as two speakers rather than as a log with an occasional bolded line in it.
 */
export function renderUserTurn(text: string): string {
  return renderUserMessage(text, renderDepth, contentWidth(), glyphs, palette.borderStyle);
}

/**
 * How much of a long block is printed before the rest is folded behind `/expand`.
 *
 * A third of a short terminal, so a single tool result can never push the answer it belongs to off
 * the top of the screen — the failure that makes people scroll back instead of reading forward.
 */
export const FOLD_AFTER_LINES = 14;

/**
 * Prints a block that may be too long, folding the tail and offering it by number.
 *
 * The whole text is kept, never discarded: the point of folding rather than truncating is that the
 * detail is one word away instead of gone.
 */
export function writeFoldable(label: string, rendered: { text: string; hidden: number; full: string }): void {
  out.write(`${rendered.text}\n`);
  if (rendered.hidden > 0) {
    const id = expandables.add(label, rendered.full, rendered.hidden);
    out.write(`${GUTTER}${expandHint(id, rendered.hidden, renderDepth, glyphs)}\n`);
  }
}

/**
 * The code a `write_file` or `edit_file` call carried, shown under its tool line.
 *
 * Read from the *call's own arguments*: that is what was sent, it costs no round trip to a possibly
 * remote sandbox to fetch it back, and it is the only version guaranteed to be the one this line is
 * reporting on.
 */
export function renderWrittenCode(toolName: string, args: Record<string, unknown>): void {
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return;
  const style_ = sectionStyle();
  if (toolName === "write_file") {
    const content = typeof args.content === "string" ? args.content : "";
    if (content === "") return;
    writeFoldable(path, renderFileChange({ path, kind: "write", content }, style_, { maxLines: FOLD_AFTER_LINES }));
    return;
  }
  const before = typeof args.oldText === "string" ? args.oldText : "";
  const after = typeof args.newText === "string" ? args.newText : "";
  if (before === "" && after === "") return;
  writeFoldable(path, renderFileChange({ path, kind: "edit", before, after }, style_, { maxLines: FOLD_AFTER_LINES }));
}

/**
 * A command's output, as a test report when it is one and as folded output when it is not.
 *
 * The distinction is worth drawing because the two are read completely differently: nobody reads
 * test output top to bottom, they look for the failures — so a run that parses is re-laid-out into
 * sections, and anything else is shown as it came, folded, exactly as a terminal would.
 */
export function renderCommandOutput(content: string): void {
  const style_ = sectionStyle();
  const report = parseTestOutput(content);
  if (report) {
    const rendered = renderTestReport(report, style_, { expandHint: "/expand for the raw output" });
    out.write(`${rendered}\n`);
    // The raw output is kept regardless of whether the report folded anything: a parser that read
    // the run slightly wrong is exactly when someone wants the original, and by then the process
    // that produced it is gone.
    const lines = content.split("\n").length;
    const id = expandables.add(`${report.framework} output`, content.replace(/\n$/, ""), lines);
    out.write(`${GUTTER}${expandHint(id, lines, renderDepth, glyphs)}\n`);
    return;
  }
  const body = content.replace(/\n$/, "").split("\n");
  // One or two lines of output already fit on the tool line's own summary; printing them again
  // below it would be the same words twice.
  if (body.length <= 2) return;
  const shown = body.slice(0, FOLD_AFTER_LINES);
  writeFoldable("command output", {
    text: panel(shown, style_, { title: "output", gutterOnly: true }),
    hidden: Math.max(0, body.length - FOLD_AFTER_LINES),
    full: panel(body, style_, { title: "output", gutterOnly: true }),
  });
}

/**
 * What a submitted message looks like in the transcript: a chat bubble, sized to its content and
 * labelled with the speaker, matching the input bar that produced it.
 *
 * The echo is not redundant with what the user just typed. The input bar lives on a fixed footer
 * row that the next message overwrites, so without this the transcript would be a record of the
 * assistant talking to itself — every reply present, nothing it was replying to.
 */
export function renderUserMessage(
  text: string,
  depth: ReturnType<typeof detectColorDepth>,
  width: number,
  glyphSet: GlyphSet = UNICODE_GLYPHS,
  borderStyle: "round" | "single" | "double" | "none" = "round",
): string {
  // Wrapped per line rather than as one blob: a pasted stack trace or a numbered list is a shape
  // the sender chose, and reflowing it into a paragraph destroys the thing that made it readable.
  const body = text.split("\n").flatMap((line) => wrapPlain(line, Math.max(8, width - 6)));
  return box(body, { depth, width, title: "you", titleColor: "green", glyphs: glyphSet, borderStyle, palette });
}

/**
 * How long a turn must last before it is worth animating.
 *
 * A cached or refused turn can be over in tens of milliseconds, and drawing a spinner frame for it
 * only to erase it reads as a flicker rather than as feedback. Below what a person registers as a
 * pause, so a real turn still starts animating immediately as far as anyone can tell.
 */
export const SPINNER_START_DELAY_MS = 200;

export function renderEvent(event: ArchymedesEvent): void {
  // Every event clears the spinner before printing. If the spinner is still running its next tick
  // redraws the bar underneath whatever just printed, so feedback continues through a whole run of
  // tool calls rather than only filling the first gap.
  statusBar.clear();

  if (event.type === "runtime" && event.event.type === "assistant_delta") {
    // The first delta of a turn is the one moment worth a header: it is where a reader's eye needs
    // to land to tell "the assistant is now speaking" apart from the tool lines and the user's own
    // request above it. Every delta after the first is the same reply continuing, not a new one.
    if (activity.awaitingFirstDelta) {
      const label = activity.toolCalls > 0 || touchedFiles.size > 0 ? "summary" : "Archymedes";
      out.write(`\n${rule(sectionStyle(), { label, tone: "accent" })}\n`);
    }
    // The model is visibly talking now, so animation yields the row to streamed Markdown.
    // This may be the first answer of the turn or the answer after a tool operation. Tool calls
    // restart the spinner even after earlier prose, so every new visible delta owns the screen and
    // must stop animation before writing.
    activity.awaitingFirstDelta = false;
    spinner?.stop();
    forgetToolLines();
    markdown.push(event.event.text);
    return;
  }

  // Anything else prints on its own row, so a half-written assistant line is closed off first.
  const wasStreaming = markdown.active;
  markdown.end();
  if (wasStreaming) forgetToolLines();

  if (event.type === "checkpoint") {
    forgetToolLines();
    out.write(style.dim(`  ${glyphs.elbow} checkpoint ${event.checkpoint.tree.slice(0, 8)}\n`));
    return;
  }
  if (event.type === "compaction") {
    forgetToolLines();
    out.write(style.dim(`  ${glyphs.elbow} compacted context (${event.messagesBefore} → ${event.messagesAfter} messages)\n`));
    return;
  }

  const runtime = event.event;
  if (runtime.type === "provider_retry") {
    forgetToolLines();
    const reason = runtime.reason === "rate_limit" ? "rate limited"
      : runtime.reason === "server" ? "provider unavailable"
      : runtime.reason === "network" ? "connection failed"
      : runtime.reason === "timeout" ? "request timed out"
      : "temporary provider failure";
    out.write(style.yellow(`  ${glyphs.elbow} ${reason}; retrying model request ${runtime.nextAttempt}/${runtime.maxAttempts} in ${runtime.delayMs}ms\n`));
    return;
  }
  if (runtime.type === "model_turn") {
    // Silent by design: every call this turn announces itself below, so a "thinking (3 tool
    // calls)" line would only restate what the next three lines are about to say.
    activity.tokens += runtime.usage.inputTokens + runtime.usage.outputTokens;
    return;
  }
  if (runtime.type === "tool_call") {
    if (!toolSectionAnnounced) {
      out.write(`\n${rule(sectionStyle(), { label: "tool activity", tone: "neutral" })}\n`);
      toolSectionAnnounced = true;
    }
    // If the model spoke before acting, the next prose is a new answer segment after the tools,
    // not a continuation of the preamble. Give that final segment its own summary divider.
    activity.awaitingFirstDelta = true;
    const detail = describeToolCall(runtime.toolName, runtime.arguments);
    // A second call announced while the first is still open makes both part of one concurrent
    // batch — retroactively mark the still-open ones too, so the whole group reads as a lane
    // rather than the first line looking like an unrelated call that happened to be nearby.
    const lane = pendingCalls.size > 0;
    if (lane) {
      for (const [id, entry] of pendingCalls) {
        if (entry.lane || entry.line < 0) continue;
        const text = toolLineText(style.dim(glyphs.pending), entry.name, style.dim(entry.detail), "", entry.effect, true);
        if (toolLines.update(entry.line, text)) pendingCalls.set(id, { ...entry, lane: true });
      }
    }
    // Announcing then rewriting needs a cursor. Piped, the announcement would be a duplicate line
    // nobody can erase, so only the completed line below is printed.
    const line = liveTerminal ? toolLines.append(toolLineText(style.dim(glyphs.pending), runtime.toolName, style.dim(detail), "", runtime.effect, lane)) : -1;
    pendingCalls.set(runtime.toolCallId, { line, detail, name: runtime.toolName, arguments: runtime.arguments, effect: runtime.effect, lane });
    activity.phase = "operation";
    activity.operation = runtime.toolName;
    // A model can stream an explanation and then begin a long command. The first delta stopped
    // the thinking animation; restart it here so the operation never becomes silent dead air.
    spinner?.start();
    return;
  }
  if (runtime.type === "tool_result") {
    activity.toolCalls += 1;
    const verificationKind = typeof runtime.data?.verificationKind === "string" ? runtime.data.verificationKind : undefined;
    if (verificationKind) {
      verificationChecks.set(verificationKind, !runtime.isError);
      sessionChecks.set(verificationKind, !runtime.isError);
    }
    // Read from the structured result rather than from the rendered checklist: the counter must
    // not depend on how the list happens to be printed.
    const items = Array.isArray(runtime.data?.items) ? runtime.data.items as Array<{ status?: string }> : undefined;
    if (items) {
      activity.steps = items.length > 0
        ? { done: items.filter((item) => item.status === "done").length, total: items.length, label: "plan" }
        : undefined;
    }
    const mark = runtime.isError ? style.red(glyphs.cross) : style.green(glyphs.check);
    const summary = summarizeToolResult(runtime.toolName, runtime.content, runtime.isError);
    // The announcement and the outcome are the same line, rewritten where it already sits. Reads
    // parallel-safe calls correctly too: several are announced before the first result returns, so
    // the line to rewrite is usually not the last one printed.
    const pending = pendingCalls.get(runtime.toolCallId);
    const completed = toolLineText(mark, runtime.toolName, style.dim(pending?.detail ?? ""), summary, runtime.effect, pending?.lane ?? false);
    if (pending === undefined || pending.line < 0 || !toolLines.update(pending.line, completed)) {
      out.write(`${completed}\n`);
    }
    pendingCalls.delete(runtime.toolCallId);

    // Output too large for the transcript did not vanish — say where it went, in the same place the
    // truncated tail used to be, so "the rest of it" is a path rather than a loss.
    if (runtime.artifact) {
      const artifact = runtime.artifact;
      out.write(style.dim(`  ${glyphs.elbow} ${artifact.lines.toLocaleString()} lines kept in ${artifact.path}\n`));
    }

    // The detail belongs *under* the line that announced it. Anything printed here ends the
    // rewritable block — the tool lines above are no longer the bottom of the screen, and touching
    // them afterward would erase whatever went in between.
    // Only the block is forgotten, never the pending map: a call still in flight keeps the
    // arguments its own result will need, and simply prints its completed line fresh instead of
    // rewriting one that is no longer at the bottom of the screen.
    if (!runtime.isError && pending) {
      if (runtime.toolName === "write_file" || runtime.toolName === "edit_file") {
        toolLines.forget();
        renderWrittenCode(runtime.toolName, pending.arguments);
        // Feeds the end-of-turn "files modified" footer and the scoreboard's line delta.
        const path = typeof pending.arguments.path === "string" ? pending.arguments.path : undefined;
        if (path) touchedFiles.add(path);
        let addedDelta = 0;
        let removedDelta = 0;
        if (runtime.toolName === "write_file") {
          const content = typeof pending.arguments.content === "string" ? pending.arguments.content : "";
          if (content) addedDelta = content.split("\n").length;
        } else {
          const before = typeof pending.arguments.oldText === "string" ? pending.arguments.oldText : "";
          const after = typeof pending.arguments.newText === "string" ? pending.arguments.newText : "";
          const stat = diffStat(diffLines(before, after));
          addedDelta = stat.added;
          removedDelta = stat.removed;
        }
        turnLineDelta.added += addedDelta;
        turnLineDelta.removed += removedDelta;
        if (path) {
          const prior = sessionFiles.get(path) ?? { added: 0, removed: 0 };
          sessionFiles.set(path, { added: prior.added + addedDelta, removed: prior.removed + removedDelta });
        }
      } else if (runtime.toolName === "run_command") {
        toolLines.forget();
        renderCommandOutput(runtime.content);
      }
    }

    const stillRunning = pendingCalls.values().next().value as { name: string } | undefined;
    if (stillRunning) {
      activity.phase = "operation";
      activity.operation = stillRunning.name;
    } else {
      // The next provider iteration begins immediately after the final result. There is no
      // separate "model request started" event, so this transition keeps that reasoning visible.
      activity.phase = "thinking";
      activity.operation = undefined;
    }
    return;
  }
}

export function setSpinner(next: Spinner | undefined): void {
  spinner = next;
}

export function setScreen(next: PinnedScreen | undefined): void {
  screen = next;
}

/** Per-turn counters, and a clean markdown state: an unclosed code fence from the last answer must not colour the next one as code. */
export function beginTranscriptTurn(): void {
  activity.toolCalls = 0;
  activity.tokens = 0;
  activity.phase = "thinking";
  activity.operation = undefined;
  activity.steps = undefined;
  touchedFiles = new Set();
  turnLineDelta = { added: 0, removed: 0 };
  verificationChecks = new Map();
  toolSectionAnnounced = false;
  forgetToolLines();
  markdown.reset();
}
