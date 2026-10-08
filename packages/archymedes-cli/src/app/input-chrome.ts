/**
 * The interactive terminal's chrome: the layout (fixed workspace or scrollback with a footer),
 * transcript scrolling keys, resize handling, and the suggestion dropup and ghost completion under
 * the prompt.
 *
 * Moved out of `main()` unchanged. Only installed for a real interactive TTY.
 */
import path from "node:path";
import type { Interface } from "node:readline/promises";
import { inlineCompletion, suggestionsFor } from "../catalog/commands";
import { PROMPT_PREFIX_COLUMNS } from "../render/tui";
import { buildModelCatalog } from "../session/models";
import type { WorkspaceController } from "../session/tabs";
import type { KeyBindingRegistry } from "../terminal/keybindings";
import { PinnedScreen } from "../terminal/screen";
import { isTranscriptKey, transcriptScrollForKey, type ScrollKey } from "../terminal/transcript-keys";
import { visibleWidth } from "../text/text-width";
import { runChooser, type ChooserItem } from "../ui/chooser";
import { dropupRowBudget, renderDropup, type DropupEntry } from "../ui/dropup";
import { workspaceFrameOptions } from "../ui/layout-choice";
import { replaceLine, setWorkspaceMenu, withBorrowedKeyboard } from "../ui/shortcuts";
import { WorkspaceFrame } from "../ui/workspace-frame";
import { ARCHYMEDES_CLI_VERSION } from "../platform/update";
import type { ParsedArgs } from "./args";
import type { ReadlineInternals } from "./prompts";
import type { Environment, SessionState } from "./session-state";
import type { StatusLine } from "./status-line";
import type { TabPayload } from "./tab-switching";
import { glyphs, out, palette, screen, setScreen, style } from "./transcript";

type ChromeState = Pick<SessionState, "mode" | "turnActive" | "spec" | "resolvedModelId" | "liveModels" | "where">;

/**
 * Switches between the fixed workspace and the scrollback layout.
 *
 * The footer goes up after the banner, not before — the banner is the top of the transcript, not
 * chrome that belongs pinned. `pinFooter` (`--pin`, or `ARCHYMEDES_PIN` so the choice can live in a
 * shell profile) decides whether the scrollback layout holds a scroll region.
 */
export function createLayoutSwitch(options: {
  args: ParsedArgs;
  environment: Environment;
  state: ChromeState;
  tabs: WorkspaceController<TabPayload>;
  pinFooter: boolean;
  showIdleStatus: () => void;
}): (fixed: boolean) => void {
  const { args, environment, state, tabs } = options;
  return (fixed) => {
    screen?.exit();
    setWorkspaceMenu(undefined);
    const next = fixed ? new WorkspaceFrame(process.stdout,
      () => ({ version: ARCHYMEDES_CLI_VERSION, workspace: path.basename(args.root), model: `${state.spec.label} / ${state.resolvedModelId}`, mode: state.mode, palette, glyphs, busy: state.turnActive }),
      () => tabs.active.payload.sink.log, workspaceFrameOptions(environment, process.stdin))
      : new PinnedScreen(process.stdout, { holdRegion: options.pinFooter });
    setScreen(next);
    next.enter();
    if (next instanceof WorkspaceFrame) setWorkspaceMenu(next.menu);
    options.showIdleStatus();
  };
}

/**
 * Binds the transcript scrolling keys, the resize handler and the suggestion painters to stdin.
 * Returns the scrolling keys' bind/unbind pair, which full-screen views and shutdown reuse.
 */
export function installInputChrome(options: {
  environment: Environment;
  state: ChromeState;
  readline: Interface;
  rl: Interface & ReadlineInternals;
  keys: KeyBindingRegistry;
  status: Pick<StatusLine, "showIdleStatus" | "idleStatusLine" | "inlineBar" | "promptBox">;
}): { bindFixedNavigation: () => void; unbindFixedNavigation: () => void } {
  const { environment, state, readline, rl, keys } = options;
  const { showIdleStatus, idleStatusLine, inlineBar, promptBox } = options.status;
  const fixedNavigation = (_str: string, key: ScrollKey | undefined) => {
    if (!(screen instanceof WorkspaceFrame)) return;
    screen.stopIntroMotion();
    const action = transcriptScrollForKey(key, screen.browsing);
    if (action) screen.scroll(action);
  };
  const unbindFixedNavigation = () => { process.stdin.off("keypress", fixedNavigation); };
  const bindFixedNavigation = () => { unbindFixedNavigation(); process.stdin.on("keypress", fixedNavigation); };
  bindFixedNavigation();
  process.stdout.on("resize", () => {
    screen?.resize();
    showIdleStatus();
    if (screen instanceof WorkspaceFrame && !state.turnActive) {
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
    const { moved } = promptBox.setSuggestions(lines, { mode: state.mode, workspace: state.where, status });
    if (!moved) return;
    readline.prompt(true);
    promptBox.restoreBottomBorder(state.mode, state.where, status);
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
    if (state.turnActive || browsing || isTranscriptKey(key)) return;
    const line = (readline as { line?: string }).line ?? "";
    const suggestions = suggestionsFor(line, buildModelCatalog(environment, undefined, state.liveModels).choices.map((choice) => choice.model));

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
    if (state.turnActive || browsing || !promptBox.isDrawn) return;
    const line = (readline as { line?: string }).line ?? "";
    const cursor = (readline as { cursor?: number }).cursor ?? line.length;
    // Only at the end of the line: a completion offered from the middle would be describing text
    // the cursor is not actually about to extend.
    if (cursor !== line.length) { out.write("\x1b7\x1b[K\x1b8"); return; }
    const { suffix, alternatives } = inlineCompletion(line, buildModelCatalog(environment, undefined, state.liveModels).choices.map((choice) => choice.model));
    const hint = suffix === "" ? "" : `${style.dim(suffix)}${alternatives > 0 ? style.dim(`  +${alternatives}`) : ""}`;
    out.write(`\x1b7\x1b[K${hint}\x1b8`);
  });

  /** Right arrow at the end of the line takes the offer, the way fish and every browser bar do. */
  const acceptGhost = (_str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
    if (!key || key.name !== "right" || key.ctrl || key.meta) return;
    if (state.turnActive || browsing || !promptBox.isDrawn) return;
    const line = (readline as { line?: string }).line ?? "";
    const cursor = (readline as { cursor?: number }).cursor ?? 0;
    if (cursor !== line.length) return; // mid-line, the arrow means "move right"
    const { suffix } = inlineCompletion(line, buildModelCatalog(environment, undefined, state.liveModels).choices.map((choice) => choice.model));
    if (suffix !== "") readline.write(suffix);
  };

  process.stdin.on("keypress", paintSuggestions);
  process.stdin.on("keypress", paintGhost);
  process.stdin.on("keypress", acceptGhost);

  return { bindFixedNavigation, unbindFixedNavigation };
}
