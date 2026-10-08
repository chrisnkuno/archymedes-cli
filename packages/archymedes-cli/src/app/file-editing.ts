/**
 * `/edit` and the editor `/files` opens: the built-in editor, and its "explain this file" tab.
 */
import { explainScreenRefusal, withFullScreen, type ScreenCapabilities, type TerminalControls } from "../terminal/screen-host";
import type { SessionState } from "./session-state";
import { out, palette, style } from "./transcript";

export function createFileEditing(options: {
  state: Pick<SessionState, "model" | "agent" | "ledger" | "workspace">;
  screenCapabilities: () => ScreenCapabilities;
  terminalControls: () => TerminalControls;
  /** Whether `/edit` saves on its own after a pause in typing (`ARCHYMEDES_EDITOR_AUTOSAVE=on`). */
  autosave?: () => boolean;
}) {
  const { state } = options;

  /**
   * One small, tool-less call to the session's own model to explain a file — the editor's AI tab.
   *
   * Same shape as the model suggestions after a turn: no tools, a hard cap on output, and the usage
   * billed to the ledger as its own tiny turn rather than swallowed, since unlike a suggestion this
   * is a call the reader asked for by name and would reasonably expect to see costed.
   */
  const explainCode = async (content: string, target: string): Promise<string> => {
    const started = Date.now();
    const turn = await state.model.complete({
      messages: [
        { role: "system", content: "Explain the given source file to a developer reading it for the first time. Cover what it does, its key functions or exports, and any non-obvious design decisions. Plain prose, no code fences, under 200 words." },
        { role: "user", content: `File: ${target}\n\n${content}` },
      ],
      tools: [],
      maxOutputTokens: 500,
      safetyIdentifier: state.agent.sessionId,
    });
    state.ledger.record({ usage: turn.usage, iterations: 1, toolCalls: 0, elapsedMs: Date.now() - started });
    return turn.content.trim() || "The model returned no explanation.";
  };

  /**
   * Opens a file in the built-in editor and writes it back if it was saved.
   *
   * Reads and writes through the workspace rather than `node:fs`, so `/edit` works identically
   * against a remote sandbox — the same rule every tool follows. The file is only written when the
   * editor reports a save, so quitting really is a discard.
   */
  const editFile = async (target: string): Promise<void> => {
    let existing = "";
    try {
      existing = (await state.workspace.readFile(target, {})).content;
    } catch (error) {
      // A missing path is a new file, which is the ordinary way `nano somefile` is used. Anything
      // else — a directory, a permission error — is reported rather than silently starting blank.
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|ENOENT|no such file/i.test(message)) {
        out.write(style.yellow(`  Cannot open ${target}: ${message}\n`));
        return;
      }
    }
    let saved: string | undefined;
    let autosaved: string | undefined;
    const outcome = await withFullScreen(options.screenCapabilities(), options.terminalControls(), async () => {
      const { runEditorScreen } = await import("../ui/editor-screen");
      saved = await runEditorScreen({
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        path: target,
        content: existing,
        palette,
        explain: explainCode,
        ...(options.autosave?.() ? { autosave: async (content: string) => { await state.workspace.writeFile(target, content); autosaved = content; } } : {}),
      });
    });
    if (!outcome.ok) { out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`)); return; }
    if (saved === undefined && autosaved !== undefined) { out.write(style.green(`  ${target} auto-saved.\n`)); return; }
    if (saved === undefined) { out.write(style.dim(`  ${target} left unchanged.\n`)); return; }
    if (saved === autosaved) { out.write(style.green(`  ${target} saved.\n`)); return; }
    if (saved === existing) { out.write(style.dim(`  ${target} saved with no changes.\n`)); return; }
    const result = await state.workspace.writeFile(target, saved);
    out.write(style.green(`  Saved ${result.path} (${result.bytesWritten} bytes).\n`));
  };

  return { explainCode, editFile };
}
