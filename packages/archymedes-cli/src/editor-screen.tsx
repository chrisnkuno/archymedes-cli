/** @jsxImportSource @termuijs/jsx */
import { useInput, useState } from "@termuijs/jsx";
import { Box, Text } from "@termuijs/widgets";
import {
  applyEditorAction,
  composeEditorFrame,
  editorContent,
  initialEditorState,
  keyToEditorAction,
  type EditorState,
} from "./editor";
import {
  composeExplainPanel,
  cycleExplainTab,
  initialExplainPanelState,
  toggleExplainPanel,
  withAiExplanation,
  type ExplainPanelState,
} from "./explain-view";
import { NO_COLOR_PALETTE, type Palette } from "./theme";

/**
 * The editor, as a screen — now with an explainable view alongside it.
 *
 * Same split as `file-screen.tsx`: `editor.ts` owns every decision about what a key means and what
 * the document becomes, and this file does the two things a pure reducer cannot — turn rows into
 * widgets, and write the file when the reducer says to. `explain-view.ts` owns the side panel the
 * same way, kept as a second, independent piece of state so opening it can never perturb an edit in
 * progress: `Ctrl+E` toggles it and `[`/`]` cycle its tabs, three chords `editor.ts` never binds in
 * normal mode, so they are intercepted here before a key ever reaches the editor's own reducer.
 */

type WidgetProps = Record<string, unknown> & { children?: unknown };
const Panel = Box as unknown as (props: WidgetProps) => unknown;
const Line = Text as unknown as (props: WidgetProps) => unknown;

type TermUIKey = { key?: string; ctrl?: boolean; shift?: boolean; alt?: boolean };

export type EditorScreenProps = {
  columns: number;
  rows: number;
  path: string;
  content: string;
  /** Reports the final content when it was saved, or undefined when the reader quit without saving. */
  onExit: (saved: string | undefined) => void;
  palette?: Palette;
  /** Asks the model to explain the file as it stands. Omitted, the AI tab says so instead of failing. */
  explain?: (content: string, path: string) => Promise<string>;
};

/** Two rows of chrome — status above, key bar below — leaving the rest for text. */
const CHROME_ROWS = 2;
/** The panel's share of the width, clamped so neither side of the split becomes unreadable. */
const MIN_CODE_COLUMNS = 30;
const MAX_PANEL_COLUMNS = 52;

function panelWidthFor(columns: number): number {
  if (columns - MIN_CODE_COLUMNS < 20) return 0;
  return Math.min(MAX_PANEL_COLUMNS, Math.floor(columns * 0.38), columns - MIN_CODE_COLUMNS);
}

export function EditorScreen({ columns, rows, path, content, onExit, palette = NO_COLOR_PALETTE, explain }: EditorScreenProps) {
  const [state, setState] = useState<EditorState>(() => initialEditorState(path, content, Math.max(1, rows - CHROME_ROWS)));
  const [panel, setPanel] = useState<ExplainPanelState>(() => initialExplainPanelState());
  const panelWidth = panel.open ? panelWidthFor(columns) : 0;
  const codeWidth = panelWidth > 0 ? columns - panelWidth - 1 : columns;

  const askAi = (currentContent: string) => {
    if (!explain) { setPanel((current) => withAiExplanation(current, { status: "error", message: "no model available in this session" })); return; }
    setPanel((current) => withAiExplanation(current, { status: "loading" }));
    void explain(currentContent, path).then(
      (text) => setPanel((current) => withAiExplanation(current, { status: "ready", text })),
      (error) => setPanel((current) => withAiExplanation(current, { status: "error", message: error instanceof Error ? error.message : String(error) })),
    );
  };

  useInput((input: string, key: TermUIKey) => {
    if (key?.ctrl && key?.key === "e") { setPanel((current) => toggleExplainPanel(current)); return; }
    if (panel.open && state.mode === "normal" && !state.search.typing) {
      if (input === "]") { setPanel((current) => cycleExplainTab(current, 1)); return; }
      if (input === "[") { setPanel((current) => cycleExplainTab(current, -1)); return; }
      if (input === "?" && panel.tab === "ai" && panel.ai.status !== "loading") { askAi(editorContent(state)); return; }
    }
    setState((current) => {
      const action = keyToEditorAction({ name: key?.key, ctrl: key?.ctrl, shift: key?.shift }, input, current);
      const { state: next, effect } = applyEditorAction(current, action);
      // The host writes on save and reports on quit. `quit` deliberately does not prompt about
      // unsaved changes here: the caller has the file on disk and the returned content, and is the
      // only layer that can ask a question and wait for an answer.
      if (effect?.kind === "save") onExit(editorContent(next));
      else if (effect?.kind === "quit") onExit(undefined);
      return next;
    });
  });

  const frame = composeEditorFrame(state, codeWidth, palette.accent);
  // `editor.ts` knows nothing about the panel, so its hint is appended here rather than taught to
  // the editor's own key bar — the same reason the toggle is intercepted above rather than added to
  // `keyToEditorAction`: the panel is a second, independent feature, not a mode of the editor. Only
  // advertised while closed and only when it fits: once the panel is open its own hint row (in
  // `explain-view.ts`) takes over, with a width budget that does not compete with the code pane's.
  const lastRow = frame.length - 1;
  if (!panel.open && lastRow >= 0 && frame[lastRow].text.length + "   ^E explain".length <= codeWidth) {
    frame[lastRow] = { ...frame[lastRow], text: `${frame[lastRow].text}   ^E explain` };
  }
  // Sized to the screen's `rows`, not to `frame.length`: the editor only draws as many lines as the
  // document has, so a short file would otherwise hand the panel a height of three and silently
  // truncate everything past its tab strip and hint row.
  const panelRows = panelWidth > 0
    ? composeExplainPanel({ path, before: content, after: editorContent(state), panel }, panelWidth - 2, rows)
    : [];

  return (
    <Panel flexDirection="row" width={columns} height={rows}>
      <Panel flexDirection="column" width={codeWidth} height={rows}>
        {frame.map((line, index) => (
          <Line key={`row-${index}`} bold={line.bold} dimColor={line.dim} color={line.color}>
            {line.text}
          </Line>
        ))}
      </Panel>
      {panelWidth > 0 && (
        <Panel flexDirection="column" width={panelWidth} height={rows}>
          {panelRows.map((line, index) => (
            <Line key={`explain-${index}`} bold={line.bold} dimColor={line.dim} color={line.color}>
              {line.text}
            </Line>
          ))}
        </Panel>
      )}
    </Panel>
  );
}

/**
 * Opens the editor and resolves with the saved content, or undefined if it was closed unsaved.
 *
 * TermUI is imported dynamically so a session that never edits anything pays nothing for it — the
 * same arrangement the guide, the file picker and the control panel all use.
 */
export async function runEditorScreen(options: {
  columns: number;
  rows: number;
  path: string;
  content: string;
  palette?: Palette;
  explain?: (content: string, path: string) => Promise<string>;
}): Promise<string | undefined> {
  const { renderApp } = await import("@termuijs/jsx");
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (saved: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(saved);
    };
    void renderApp(EditorScreen as never, {
      columns: options.columns,
      rows: options.rows,
      path: options.path,
      content: options.content,
      palette: options.palette,
      explain: options.explain,
      onExit: finish,
      fullscreen: true,
    } as never).catch(() => finish(undefined));
  });
}
