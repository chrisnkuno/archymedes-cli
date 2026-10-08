/**
 * The footer between turns and the inline input bar, and how a full-screen view borrows the
 * terminal from them.
 */
import { formatMoney } from "@archymedes/core/money";
import { formatModelAllowance } from "@archymedes/core/providers/free-usage";
import type { Interface } from "node:readline/promises";
import { paceBadge } from "../commands/pacing";
import { formatHeaderSegments, PromptBox, promptStatusRoom, renderPromptBox } from "../render/tui";
import { renderTabStrip, type WorkspaceController } from "../session/tabs";
import { currentScreenCapabilities, type TerminalControls } from "../terminal/screen-host";
import type { detectColorDepth } from "../text/color-depth";
import { setWorkspaceMenu } from "../ui/shortcuts";
import { WorkspaceFrame } from "../ui/workspace-frame";
import type { SessionState } from "./session-state";
import { describeTab, type TabPayload } from "./tab-switching";
import { glyphs, out, palette, screen, statusBar, style } from "./transcript";

export type StatusLine = ReturnType<typeof createStatusLine>;

export function createStatusLine(options: {
  state: Pick<SessionState, "mode" | "pace" | "memories" | "ledger" | "turnActive" | "where">;
  tabs: WorkspaceController<TabPayload>;
  balanceHeader: () => { full: string; compact: string };
  depth: ReturnType<typeof detectColorDepth>;
  interactive: boolean;
  ttyMode: boolean;
  readline: Interface;
  /** The keyboard hooks as they are at call time: each is reinstalled while the session runs. */
  keyboard: { uninstallShortcuts: () => void; installShortcuts: () => void; bindFixedNavigation: () => void };
}) {
  const { state, tabs, depth, readline } = options;

  /** How wide a status line may be to fit on the bar's top border beside the title. */
  const statusRoomFor = (width: number) => promptStatusRoom(state.mode, state.where, width, glyphs);

  /**
   * What the pinned footer shows between turns: not the spinner's "thinking" line, which only
   * exists while one is active, but the quieter facts worth having pinned at rest — mode, the tab
   * strip when there is more than one, and the running total. Redrawn once per prompt cycle (see
   * the loop) rather than pushed from every command that could change one of these, the same
   * way a real status bar settles on its next natural repaint instead of being wired to every
   * mutation site.
   */
  const idleStatusLine = (): string => {
    const strip = tabs.size > 1 ? `${renderTabStrip(tabs.views(describeTab), { width: screen?.current.columns ?? 80, glyphs })} ${glyphs.middot} ` : "";
    // Free mode spends a daily token allowance, not money: its meter replaces the $0 total.
    const allowance = state.ledger.latestAllowance;
    const cost = allowance ? formatModelAllowance(allowance) : state.ledger.displayTotal ? formatMoney(state.ledger.displayTotal) : "cost unknown";
    const badge = state.pace === "off" ? "" : ` ${style.yellow(paceBadge(state.pace, glyphs))}`;
    const remembered = state.memories.length > 0 ? ` ${style.dim(`${glyphs.middot} ${state.memories.length} remembered`)}` : "";
    const balance = options.balanceHeader();
    const room = screen ? statusRoomFor(screen.current.columns) : process.stdout.columns ?? 80;
    return formatHeaderSegments([
      balance,
      ...(strip ? [{ full: strip.trim() }] : []),
      { full: `${style.cyan(state.mode)}${badge}`, compact: style.cyan(state.mode) },
      { full: allowance?.warning ? style.yellow(cost) : style.dim(cost) },
      ...(remembered ? [{ full: remembered.trimStart() }] : []),
    ], room, ` ${glyphs.middot} `);
  };

  /**
   * How a full-screen view borrows the terminal. One definition, used by every screen, because the
   * six steps have to happen in the same order every time and a missed one leaves a dead prompt.
   */
  const terminalControls = (): TerminalControls => ({
    clearStatus: () => statusBar.clear(),
    releaseScreen: () => { screen?.exit(); setWorkspaceMenu(undefined); },
    uninstallShortcuts: () => options.keyboard.uninstallShortcuts(),
    installShortcuts: () => options.keyboard.installShortcuts(),
    pauseInput: () => readline.pause(),
    resumeInput: () => readline.resume(),
    restoreScreen: () => { screen?.enter(); if (screen instanceof WorkspaceFrame) setWorkspaceMenu(screen.menu); options.keyboard.bindFixedNavigation(); showIdleStatus(); },
  });

  const screenCapabilities = () => currentScreenCapabilities(options.interactive, process.stdout, process.env);

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
    renderPromptBox({ mode: state.mode, workspace: state.where, depth, width: promptWidth(), status, glyphs, palette });

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
  const inlineBar = (): boolean => options.ttyMode && screen !== undefined && !screen.pinned;

  /**
   * Repaints the footer with a new status, leaving the input line alone.
   *
   * Both borders are redrawn, not just the top: on a resize the bottom border has moved to a row
   * that previously held transcript, and only the caller of this knows the layout changed.
   *
   * With `--pin` it goes to the reserved row; without one it is drawn by `StatusBar`, which erases
   * and redraws itself in place — the same information, at the cost of living in the flow of the
   * transcript rather than above it, and with the terminal's own scrollback left intact.
   */
  const showStatus = (status: string): void => {
    if (screen?.pinned) {
      const frame = promptFrame(status);
      screen.renderStatus(frame.top);
      screen.renderPromptBottom(frame.bottom);
    } else if (inlineBar() && !state.turnActive) {
      // Between turns the inline bar carries the status on its own top border, so a separate
      // status line would say the same thing twice, one row apart. Mid-turn there is no bar drawn
      // — the activity line is the only status there is — and `statusBar` remains the right home.
      statusBar.clear();
    } else if (options.ttyMode) statusBar.renderLine(status);
  };

  const showIdleStatus = (): void => showStatus(idleStatusLine());

  return { idleStatusLine, terminalControls, screenCapabilities, promptFrame, promptBox, inlineBar, statusRoomFor, showStatus, showIdleStatus };
}
