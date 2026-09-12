import { BOLD, REVERSE, paint } from "./ansi";
import { clipTo } from "./chooser";
import { BEGIN_SYNC, END_SYNC, ENTER_ALTERNATE_SCREEN, LEAVE_ALTERNATE_SCREEN } from "./fixed-screen";
import { ASCII_GLYPHS, type GlyphSet } from "./glyphs";
import { visibleWidth } from "./markdown";
import type { LineLog } from "./output";
import { PinnedScreen, type ScreenStream } from "./screen";
import type { Palette } from "./theme";
import { renderIdentity } from "./identity";

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
    .replace(/\x1b[^\[]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => c === "\x1b" ? c : "");
  for (const part of safe.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) { result += part; continue; }
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(part)) {
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
    ? ink(` ${mode.toUpperCase()} `, color + BOLD + REVERSE) : ink(` ${mode} `, p.muted)).join(ink("│", p.muted));
  const second = width >= 48 ? ` ${modes}` : ` ${ink(`[${context.mode.toUpperCase()}]`, color + BOLD)}`;
  const hint = width >= 90 ? `  /mode choose  Ctrl+G menu` : "";
  const model = clean(context.model);
  const navigation = width >= 72 ? "PgUp/PgDn history  Esc live " : "";
  const modelWidth = Math.max(0, width - navigation.length - 3);
  const shownModel = clipTo(model, modelWidth, g);
  const third = ` ${ink(shownModel, p.secondary)}${" ".repeat(Math.max(1, width - visibleWidth(shownModel) - navigation.length - 1))}${ink(navigation)}`;
  const rule = ink(` ${g.boxHorizontal.repeat(Math.max(0, width - 2))} `, p.muted);
  return [frameText(first, width), frameText(second + ink(hint), width), frameText(third, width), frameText(rule, width)];
}

/** A real session surface: fixed chrome, retained per-tab history and bounded menu overlays. */
export class WorkspaceFrame extends PinnedScreen {
  private active = false;
  private timer?: ReturnType<typeof setInterval>;
  private phase = 0;
  private offset = 0;
  private overlay?: string;
  private cachedLog?: LineLog;
  private cachedSize = -1;
  private cachedWidth = -1;
  private cachedPending = "";
  private lines: string[] = [];
  private introLog?: LineLog;
  private introSize = -1;
  private heldText?: string;
  private cachedHeldText?: string;
  private introMotion = true;

  constructor(private readonly output: ScreenStream, private readonly context: () => WorkspaceFrameContext,
    private readonly history: () => LineLog, private readonly motion = true) {
    super(output, { holdRegion: true, headerRows: 4 });
  }

  override enter(): void {
    if (this.active) return;
    this.active = true;
    process.once("exit", this.restoreOnExit);
    process.once("SIGTERM", this.terminate);
    if (!this.introLog) { this.introLog = this.history(); this.introSize = this.history().size; }
    this.output.write(`${ENTER_ALTERNATE_SCREEN}\x1b[2J`);
    super.enter();
    this.refresh();
    if (this.motion) {
      this.timer = setInterval(() => {
        this.phase++;
        if (this.introMotion && this.showIntro() && !this.overlay) this.refresh();
        else if (this.context().busy || this.overlay || this.offset) this.drawHeader();
      }, 120);
      this.timer.unref();
    }
  }

  override exit(): void {
    if (!this.active) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.active = false;
    process.off("exit", this.restoreOnExit);
    process.off("SIGTERM", this.terminate);
    this.output.write(`\x1b[r\x1b[?25h${LEAVE_ALTERNATE_SCREEN}`);
  }

  private readonly restoreOnExit = () => this.exit();
  private readonly terminate = () => { this.exit(); process.exit(143); };

  override resize() {
    const layout = super.resize();
    if (this.active) { this.output.write("\x1b[2J"); this.refresh(); }
    return layout;
  }

  /** Transcript output remains native while live, including streaming and replaceable tool blocks. */
  write(text: string): void {
    if (!this.active || (!this.offset && !this.overlay)) this.output.write(text);
    else this.drawHeader();
  }

  override renderStatus(text: string): void { super.renderStatus(text); this.drawHeader(); }

  private drawHeader(): void {
    if (!this.active) return;
    const label = this.overlay ? "MENU" : this.offset ? `HISTORY -${this.offset}` : this.context().busy ? "WORKING" : "LIVE";
    const rows = workspaceHeader(this.context(), this.current.columns, this.phase, label).slice(0, this.current.scrollTop - 1);
    this.output.write(`${BEGIN_SYNC}\x1b7${rows.map((line, i) => `\x1b[${i + 1};1H\x1b[2K${line}`).join("")}\x1b8${END_SYNC}`);
  }

  private projected(): string[] {
    const log = this.history();
    const width = Math.max(1, this.current.columns - 1);
    if (this.cachedLog === log && this.cachedSize === log.size + log.dropped && this.cachedPending === log.pending && this.cachedWidth === width && this.cachedHeldText === this.heldText) return this.lines;
    this.cachedLog = log;
    this.cachedSize = log.size + log.dropped;
    this.cachedPending = log.pending;
    this.cachedWidth = width;
    this.cachedHeldText = this.heldText;
    // Replayed history is plain text; terminal cursor commands are never executed a second time.
    const plain = (this.heldText ?? [...log.lines, ...(log.pending ? [log.pending] : [])].join("\n"))
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g, "")
      .split("\n").map((line) => line.replace(/^.*\r(?=.)/, "").replace(/\r/g, "")).join("\n");
    this.lines = [];
    for (const line of plain.split("\n")) {
      let row = "";
      let used = 0;
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)) {
        const size = visibleWidth(segment);
        if (used + size > width && row) { this.lines.push(row); row = ""; used = 0; }
        row += size > width ? "?" : segment;
        used += Math.min(size, width);
      }
      this.lines.push(row);
    }
    return this.lines;
  }

  private showIntro(): boolean {
    return this.history() === this.introLog && this.history().size === this.introSize && !this.context().busy && !this.offset;
  }

  refresh(): void {
    if (!this.active) return;
    const height = this.current.scrollBottom - this.current.scrollTop + 1;
    const lines = this.projected();
    this.offset = Math.min(this.offset, Math.max(0, lines.length - height));
    const end = Math.max(0, lines.length - this.offset);
    let body = lines.slice(Math.max(0, end - height), end);
    if (this.showIntro()) {
      const context = this.context();
      const warnings = lines.filter((line) => /No session spend cap|No price configured|No current.*rate/.test(line));
      body = renderIdentity({ ...context, width: this.current.columns - 1, rows: height >= 15 ? 24 : 12,
        angle: this.phase * 0.065 }).split("\n");
      body.push("", ...warnings.map((line) => paint(line, context.palette.warning, context.palette.depth)));
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
    this.output.write(`${BEGIN_SYNC}\x1b7${Array.from({ length: height }, (_, i) => `\x1b[${this.current.scrollTop + i};1H\x1b[2K${frameText(body[i] ?? "", this.current.columns - 1)}`).join("")}\x1b8${END_SYNC}`);
    this.drawHeader();
  }

  navigate(direction: "up" | "down" | "live"): void {
    if (this.overlay) return;
    if (direction === "up" && !this.offset) {
      const log = this.history();
      this.heldText = [...log.lines, ...(log.pending ? [log.pending] : [])].join("\n");
    }
    const page = Math.max(1, this.current.scrollBottom - this.current.scrollTop - 1);
    this.offset = direction === "live" ? 0 : Math.max(0, this.offset + (direction === "up" ? page : -page));
    if (!this.offset) this.heldText = undefined;
    this.refresh();
  }

  get browsing(): boolean { return this.offset > 0; }

  stopIntroMotion(): void { this.introMotion = false; }

  readonly menu = {
    paint: (frame: string) => { this.overlay = frame; this.refresh(); },
    erase: () => { this.overlay = undefined; this.refresh(); this.parkInTranscript(); },
    height: () => Math.max(1, this.current.scrollBottom - this.current.scrollTop - 1),
    width: () => Math.max(1, Math.min(88, this.current.columns - 6) - 4),
  };
}
