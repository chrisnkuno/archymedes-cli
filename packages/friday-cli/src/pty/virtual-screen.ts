/**
 * What a person would actually see: pty output replayed through a real terminal emulator.
 *
 * The raw stream is not the screen. The fixed layout paints by cursor address, repaints regions
 * in place and erases menus when they close, so text that was once written can be long gone and
 * text on screen may never appear contiguously in the stream. Navigation is about what is on
 * screen *now* — where the cursor is, which legend is showing, whether the menu really closed —
 * so judging it needs the emulated grid, not the byte log.
 */
import xterm from "@xterm/headless";
import type { ArchymedesProcess } from "./harness";

const { Terminal } = xterm as unknown as typeof import("@xterm/headless");

export type ScreenSnapshot = {
  /** Visible rows, trailing spaces trimmed. */
  lines: string[];
  cursor: { row: number; col: number };
  /** True when the alternate buffer (a full-screen view) is active. */
  alternate: boolean;
};

export class VirtualScreen {
  private readonly terminal: InstanceType<typeof Terminal>;
  private fed = 0;

  constructor(private readonly process: ArchymedesProcess, readonly cols: number, readonly rows: number) {
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  }

  /** Feeds everything written since the last call and resolves once the emulator has parsed it. */
  async sync(): Promise<void> {
    const output = this.process.output();
    const chunk = output.slice(this.fed);
    this.fed = output.length;
    if (!chunk) return;
    await new Promise<void>((resolve) => this.terminal.write(chunk, resolve));
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  async snapshot(): Promise<ScreenSnapshot> {
    await this.sync();
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.terminal.rows; row += 1) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    }
    return { lines, cursor: { row: buffer.cursorY, col: buffer.cursorX }, alternate: buffer.type === "alternate" };
  }

  /** The screen as text: blank lines collapsed so a judge or a diff reads the content, not the padding. */
  async text(): Promise<string> {
    const { lines } = await this.snapshot();
    return compactScreen(lines);
  }
}

export function compactScreen(lines: readonly string[]): string {
  const out: string[] = [];
  let repeats = 0;
  const flushRepeats = () => {
    if (repeats > 0) out.push(`(… ${repeats} more identical row${repeats === 1 ? "" : "s"})`);
    repeats = 0;
  };
  for (const raw of lines) {
    const line = raw.trim() === "" ? "" : raw;
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    // A column divider repeated down an empty pane is one fact, not twenty rows: collapsing it keeps
    // the screen's legend inside the judge's state budget instead of past the cut.
    if (line !== "" && out[out.length - 1] === line) { repeats += 1; continue; }
    flushRepeats();
    out.push(line);
  }
  flushRepeats();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** Waits until the screen stops changing for `quietMs`, so a snapshot is a settled frame, not a half-painted one. */
export async function settle(screen: VirtualScreen, quietMs = 250, timeoutMs = 4_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let previous = await screen.text();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = await screen.text();
    if (current !== previous) { previous = current; stableSince = Date.now(); continue; }
    if (Date.now() - stableSince >= quietMs) return current;
  }
  return previous;
}
