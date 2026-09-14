import { BOLD, REVERSE, paint } from "../text/ansi";
import { clipTo, visibleWidth } from "../text/text-width";
import { BEGIN_SYNC, DISABLE_MOUSE, ENABLE_MOUSE, END_SYNC, ENTER_ALTERNATE_SCREEN, LEAVE_ALTERNATE_SCREEN } from "../terminal/fixed-screen";
import { ASCII_GLYPHS, type GlyphSet } from "../text/glyphs";
import type { LineLog } from "../terminal/output";
import { PinnedScreen, type ScreenStream } from "../terminal/screen";
import type { Palette } from "../theme/theme";
import { renderIdentity } from "../render/identity";
import { WHEEL_ROWS, type TranscriptScroll } from "../terminal/transcript-keys";
import { transcriptRows } from "../terminal/transcript-rows";
import { applyViewport, atBottom, atTop, newViewport, scrollFraction, visibleLines, type ViewportState } from "../terminal/viewport";
import { searchViewport, stepViewportSearch, type ViewportSearch } from "../terminal/viewport-search";
import { installWheelFilter, type WheelInputSource } from "../terminal/wheel-input";

export type WorkspaceFrameContext = {
  version: string;
  workspace: string;
  model: string;
  mode: string;
  palette: Palette;
  glyphs: GlyphSet;
  busy: boolean;
};

/** Clips styled text on grapheme boundaries; only SGR escapes may reach the frame. */
export function frameText(text: string, width: number): string {
  let result = "";
  let columns = 0;
  const safe = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[(?![0-9;]*m)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[^\[]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => c === "\x1b" ? c : c === "\t" ? " " : "");
  for (const part of safe.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) { result += part; continue; }
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(part.replace(/\x1b/g, ""))) {
      if (columns + visibleWidth(segment) > width) return result + (result.includes("\x1b") ? "\x1b[0m" : "");
      result += segment;
      columns += visibleWidth(segment);
    }
  }
  return result + (result.includes("\x1b") ? "\x1b[0m" : "");
}

export function workspaceHeader(context: WorkspaceFrameContext, width: number, phase = 0, position = "LIVE"): string[] {
  const { palette: p, glyphs: g } = context;
  const color = ({ plan: p.warning, build: p.primary, auto: p.success, defender: p.error } as Record<string, string>)[context.mode] ?? p.primary;
  const ink = (s: string, c = p.muted) => paint(s, c, p.depth);
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  const ascii = g === ASCII_GLYPHS || g.boxHorizontal === "-";
  const pulse = context.busy || position === "MENU" || position.startsWith("HISTORY");
  const marks = ascii ? ["/\\", "<>", "\\/"] : ["◇", "◈", "◆", "◈"];
  const mark = pulse ? marks[phase % marks.length] : (ascii ? "/\\" : "◇");
  const title = ` ${mark} ARCHYMEDES`;
  const tail = width >= 72 ? `v${context.version}  ${position} ` : `${position} `;
  const room = Math.max(0, width - visibleWidth(title) - tail.length - 2);
  const workspace = clipTo(clean(context.workspace), room, g);
  const first = ink(title, p.primary + BOLD) + "  " + ink(workspace, p.text)
    + " ".repeat(Math.max(1, width - visibleWidth(title) - 2 - visibleWidth(workspace) - tail.length))
    + ink(tail, context.busy || position !== "LIVE" ? color + BOLD : p.muted);
  const modes = ["plan", "build", "auto", "defender"].map((mode) => mode === context.mode
    ? ink(` ${mode.toUpperCase()} `, color + BOLD + REVERSE) : ink(` ${mode} `, p.muted)).join(ink(g.boxVertical, p.muted));
  const second = width >= 48 ? ` ${modes}` : ` ${ink(`[${context.mode.toUpperCase()}]`, color + BOLD)}`;
  const hint = width >= 90 ? `  /mode choose  Ctrl+G menu` : "";
  const model = clean(context.model);
  const navigation = width >= 72 ? (position.startsWith("HISTORY") ? "Esc live " : "PgUp/wheel history ") : "";
  const modelWidth = Math.max(0, width - navigation.length - 3);
  const shownModel = clipTo(model, modelWidth, g);
  const third = ` ${ink(shownModel, p.secondary)}${" ".repeat(Math.max(1, width - visibleWidth(shownModel) - navigation.length - 1))}${ink(navigation)}`;
  const rule = ink(` ${g.boxHorizontal.repeat(Math.max(0, width - 2))} `, p.muted);
  return [frameText(first, width), frameText(second + ink(hint), width), frameText(third, width), frameText(rule, width)];
}

export type WorkspaceFrameOptions = {
  /** Header and intro animation. */
  motion?: boolean;
  /** Terminal input to read wheel reports from; mouse reporting is enabled only when given. */
  input?: WheelInputSource;
};

type HeldHistory = { log: LineLog; text: string; count: number };

export type FindRequest = { kind: "query"; text: string } | { kind: "next" } | { kind: "prev" } | { kind: "off" };
export type FindResult =
  | { status: "found"; index: number; total: number; query: string }
  | { status: "none"; query: string }
  | { status: "idle" }
  | { status: "cleared" };

function logText(log: LineLog): string {
  return [...log.lines, ...(log.pending ? [log.pending] : [])].join("\n");
}

/** A real session surface: fixed chrome, retained per-tab history and bounded menu overlays. */
export class WorkspaceFrame extends PinnedScreen {
  private active = false;
  private timer?: ReturnType<typeof setInterval>;
  private phase = 0;
  private overlay?: string;
  private cachedLog?: LineLog;
  private cachedSize = -1;
  private cachedWidth = -1;
  private cachedPending = "";
  private cachedHeld?: HeldHistory;
  private lines: string[] = [];
  private introLog?: LineLog;
  private introSize = -1;
  private introPending = "";
  private suggestions: readonly string[] = [];
  /** Set while reading history: the window over a snapshot taken when scrolling began. */
  private view?: ViewportState;
  private held?: HeldHistory;
  /** Active transcript search, over the rows of the held snapshot. */
  private search?: ViewportSearch;
  private searchedLines?: readonly string[];
  private introMotion = true;
  private uninstallWheel?: () => void;
  private readonly motion: boolean;
  private readonly input?: WheelInputSource;

  constructor(private readonly output: ScreenStream, private readonly context: () => WorkspaceFrameContext,
    private readonly history: () => LineLog, options: WorkspaceFrameOptions = {}) {
    super(output, { holdRegion: true, headerRows: 4 });
    this.motion = options.motion ?? true;
    this.input = options.input;
  }

  override enter(): void {
    if (this.active) return;
    this.active = true;
    process.once("exit", this.restoreOnExit);
    process.once("SIGTERM", this.terminate);
    if (!this.introLog) { this.introLog = this.history(); this.introSize = this.history().size; this.introPending = this.history().pending; }
    if (this.input) this.uninstallWheel = installWheelFilter(this.input, (direction) => this.scroll({ kind: direction, rows: WHEEL_ROWS }));
    this.output.write(`${ENTER_ALTERNATE_SCREEN}${this.input ? ENABLE_MOUSE : ""}\x1b[2J`);
    super.enter();
    this.refresh();
    if (this.motion) {
      this.timer = setInterval(() => {
        this.phase++;
        if (this.introMotion && this.showIntro() && !this.overlay) this.refresh();
        else if (this.context().busy || this.overlay || this.view) this.drawHeader();
      }, 120);
      this.timer.unref();
    }
  }

  override exit(): void {
    if (!this.active) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.active = false;
    this.uninstallWheel?.();
    this.uninstallWheel = undefined;
    process.off("exit", this.restoreOnExit);
    process.off("SIGTERM", this.terminate);
    this.output.write(`\x1b[r\x1b[?25h${this.input ? DISABLE_MOUSE : ""}${LEAVE_ALTERNATE_SCREEN}`);
  }

  private readonly restoreOnExit = () => this.exit();
  private readonly terminate = () => { this.exit(); process.exit(143); };

  override resize() {
    this.suggestions = [];
    const layout = super.resize();
    if (this.active) { this.output.write("\x1b[2J"); this.refresh(); }
    return layout;
  }

  /** Transcript output remains native while live, including streaming and replaceable tool blocks. */
  write(text: string): void {
    if (!this.active || (!this.view && !this.overlay)) this.output.write(text);
    else this.drawHeader();
  }

  override renderStatus(text: string): void { super.renderStatus(text); this.drawHeader(); }

  private positionLabel(): string {
    if (this.overlay) return "MENU";
    if (this.view && this.search) {
      const { matches, index, query } = this.search;
      return matches.length > 0 ? `FIND ${index + 1}/${matches.length} "${query}"` : `FIND no match "${query}"`;
    }
    if (this.view && this.held) {
      const log = this.history();
      const arrived = log === this.held.log ? log.size + log.dropped - this.held.count : 0;
      const where = atTop(this.view) ? "TOP" : `${Math.round(scrollFraction(this.view) * 100)}%`;
      return `HISTORY ${where}${arrived > 0 ? ` +${arrived} new` : ""}`;
    }
    return this.context().busy ? "WORKING" : "LIVE";
  }

  private drawHeader(): void {
    if (!this.active) return;
    const rows = workspaceHeader(this.context(), this.current.columns, this.phase, this.positionLabel()).slice(0, this.current.scrollTop - 1);
    this.output.write(`${BEGIN_SYNC}\x1b7${rows.map((line, i) => `\x1b[${i + 1};1H\x1b[2K${line}`).join("")}\x1b8${END_SYNC}`);
  }

  private bodyHeight(): number {
    return this.current.scrollBottom - this.current.scrollTop + 1 - this.suggestions.length;
  }

  /** Retained output wrapped to the body width with its styling; replayed escapes never move the cursor. */
  private projected(): string[] {
    const log = this.history();
    const width = Math.max(1, this.current.columns - 1);
    if (this.cachedLog === log && this.cachedSize === log.size + log.dropped && this.cachedPending === log.pending && this.cachedWidth === width && this.cachedHeld === this.held) return this.lines;
    this.cachedLog = log;
    this.cachedSize = log.size + log.dropped;
    this.cachedPending = log.pending;
    this.cachedWidth = width;
    this.cachedHeld = this.held;
    this.lines = transcriptRows(this.held?.text ?? logText(log), width);
    return this.lines;
  }

  private showIntro(): boolean {
    return this.history() === this.introLog && this.history().size === this.introSize && this.history().pending === this.introPending && !this.context().busy && !this.view;
  }

  private releaseHistory(): void {
    this.view = undefined;
    this.held = undefined;
    this.search = undefined;
    this.searchedLines = undefined;
  }

  /** Freezes a snapshot of the log and opens a window on its last page, if not already reading history. */
  private holdHistory(): void {
    if (this.view) return;
    const log = this.history();
    this.held = { log, text: logText(log), count: log.size + log.dropped };
    this.view = applyViewport(newViewport(this.projected(), this.bodyHeight()), { kind: "bottom" });
  }

  private scrollbar(height: number, total: number): string {
    if (!this.view || height < 1) return "";
    const { palette: p, glyphs: g } = this.context();
    const ascii = g === ASCII_GLYPHS || g.boxHorizontal === "-";
    const view = this.view;
    const match = this.search && this.search.matches.length > 0 ? this.search.matches[this.search.index] - view.top : -1;
    const marker = match >= 0 && match < height ? `\x1b[${this.current.scrollTop + match};${this.current.columns}H${paint(ascii ? "<" : "◀", p.accent, p.depth)}` : "";
    if (total <= height) return marker;
    const thumb = Math.max(1, Math.round((height * height) / total));
    const start = Math.round((height - thumb) * scrollFraction(this.view));
    const column = this.current.columns;
    return Array.from({ length: height }, (_, i) => {
      const onThumb = i >= start && i < start + thumb;
      const mark = onThumb ? paint(ascii ? "#" : "┃", p.primary, p.depth) : paint(ascii ? "|" : "│", p.muted, p.depth);
      return `\x1b[${this.current.scrollTop + i};${column}H${mark}`;
    }).join("") + marker;
  }

  refresh(): void {
    if (!this.active) return;
    const height = this.bodyHeight();
    let lines = this.projected();
    if (this.view) {
      if (this.held?.log !== this.history()) this.releaseHistory();
      else {
        this.view = applyViewport(applyViewport(this.view, { kind: "resize", height }), { kind: "content", lines });
        if (this.search && this.searchedLines !== lines) {
          // A resize reflowed the rows the matches pointed at; find them again for the same query.
          const index = this.search.index;
          const redone = searchViewport(this.view, this.search.query);
          this.search = redone.search ? { ...redone.search, index: Math.min(index, Math.max(0, redone.search.matches.length - 1)) } : undefined;
          this.searchedLines = lines;
        }
        if (atBottom(this.view) && !this.search) this.releaseHistory();
      }
      if (!this.view) lines = this.projected();
    }
    let body = this.view ? visibleLines(this.view) : lines.slice(Math.max(0, lines.length - height));
    if (this.showIntro()) {
      const context = this.context();
      const warnings = lines.filter((line) => /No session spend cap|No price configured|No current.*rate/.test(line));
      body = renderIdentity({ ...context, width: this.current.columns - 1, rows: height >= 15 ? 24 : 12,
        angle: this.phase * 0.065 }).split("\n");
      body.push("", ...warnings);
      body.push(paint("  /mode choose your tools   /palette find any action", context.palette.muted, context.palette.depth));
      body = body.slice(0, height);
    }
    if (this.overlay !== undefined) {
      const { palette: p, glyphs: g } = this.context();
      const cardWidth = Math.max(1, Math.min(88, this.current.columns - 6));
      const inset = " ".repeat(Math.max(0, Math.floor((this.current.columns - cardWidth) / 2)));
      const border = (s: string) => paint(s, p.primary, p.depth);
      const muted = (s: string) => paint(s, p.muted, p.depth);
      const inner = Math.max(0, cardWidth - 4);
      const edge = g.boxHorizontal.repeat(Math.max(0, cardWidth - 2));
      const rows = this.overlay.split("\n").slice(0, Math.max(1, height - 4));
      body = rows.map((line) => {
        const text = frameText(line, inner);
        return `${inset}${border(g.boxVertical)} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${border(g.boxVertical)}`;
      });
      if (height >= 4 && cardWidth >= 4) {
        body = [
          `${inset}${border(g.boxTopLeft)}${border(edge)}${border(g.boxTopRight)}`,
          ...body,
          `${inset}${muted(g.boxBottomLeft)}${muted(edge)}${muted(g.boxBottomRight)}`,
        ];
      }
      const top = Math.max(0, Math.floor((height - body.length) / 3));
      body = [...Array<string>(top).fill(""), ...body];
    } else body = [...Array<string>(Math.max(0, Math.floor((height - body.length) * (this.showIntro() ? 0.45 : 1)))).fill(""), ...body];
    const rows = Array.from({ length: height }, (_, i) => `\x1b[${this.current.scrollTop + i};1H\x1b[2K${frameText(body[i] ?? "", this.current.columns - 1)}`).join("");
    const bar = this.overlay === undefined ? this.scrollbar(height, lines.length) : "";
    this.output.write(`${BEGIN_SYNC}\x1b7${rows}${bar}\x1b8${END_SYNC}`);
    this.drawHeader();
  }

  override renderSuggestions(lines: readonly string[]): void {
    this.suggestions = lines.slice(0, Math.max(0, Math.min(8, this.current.scrollBottom - this.current.scrollTop - 2)));
    super.renderSuggestions(lines);
    this.refresh();
  }

  override clearSuggestions(): void {
    this.suggestions = [];
    super.clearSuggestions();
    this.refresh();
  }

  /**
   * Moves the transcript window. Scrolling up from live output freezes a snapshot so arriving output
   * cannot move what is being read; reaching the bottom, `bottom` or `live` returns to live output.
   */
  scroll(action: TranscriptScroll): void {
    if (!this.active || this.overlay !== undefined) return;
    if (action.kind === "live" || action.kind === "bottom") {
      // Always repaints: a tab switch returns to live output and relies on this to show the new tab's log.
      this.releaseHistory();
      this.refresh();
      return;
    }
    if (!this.view) {
      if (action.kind === "down" || action.kind === "halfDown" || action.kind === "pageDown") return;
      this.holdHistory();
    }
    this.view = applyViewport(this.view!, action);
    if (atBottom(this.view) && !this.search) this.releaseHistory();
    this.stopIntroMotion();
    this.refresh();
  }

  /**
   * Transcript search: a query holds history and jumps to the first match at or after the view,
   * `next`/`prev` wrap around the matches, and `off` returns to live output.
   */
  find(request: FindRequest): FindResult {
    if (!this.active || this.overlay !== undefined) return { status: "idle" };
    if (request.kind === "off") {
      const had = this.search !== undefined;
      this.releaseHistory();
      this.refresh();
      return had ? { status: "cleared" } : { status: "idle" };
    }
    if (request.kind === "query") {
      this.holdHistory();
      const found = searchViewport(this.view!, request.text);
      if (!found.search || found.search.matches.length === 0) {
        this.releaseHistory();
        this.refresh();
        return found.search ? { status: "none", query: found.search.query } : { status: "idle" };
      }
      this.view = found.viewport;
      this.search = found.search;
      this.searchedLines = this.projected();
    } else {
      if (!this.view || !this.search) return { status: "idle" };
      const stepped = stepViewportSearch(this.view, this.search, request.kind === "next" ? 1 : -1);
      this.view = stepped.viewport;
      this.search = stepped.search;
    }
    this.stopIntroMotion();
    this.refresh();
    const { matches, index, query } = this.search;
    return matches.length > 0 ? { status: "found", index: index + 1, total: matches.length, query } : { status: "none", query };
  }

  get browsing(): boolean { return this.view !== undefined; }

  stopIntroMotion(): void { this.introMotion = false; }

  readonly menu = {
    paint: (frame: string) => { this.overlay = frame; this.refresh(); },
    erase: () => { this.overlay = undefined; this.refresh(); this.parkInTranscript(); },
    height: () => Math.max(1, this.current.scrollBottom - this.current.scrollTop - 1),
    width: () => Math.max(1, Math.min(88, this.current.columns - 6) - 4),
  };
}
