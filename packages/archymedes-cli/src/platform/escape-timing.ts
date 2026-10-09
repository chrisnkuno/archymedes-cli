/**
 * How long a lone Esc byte waits for the rest of an escape sequence before it counts as the Escape
 * key, in milliseconds.
 *
 * Node's readline defaults to 500ms, so every Escape in every menu — clear the filter, close the
 * picker, leave the screen — landed half a second late, and a key pressed inside that window was
 * glued onto the Esc as a meta chord and lost. Terminals deliver an arrow key's bytes together, so
 * a short wait tells them apart from a typed Esc; tmux and Neovim users tune `escape-time` down to
 * the same range for the same reason. A slow remote link that splits sequences can raise it with
 * `ARCHYMEDES_ESCAPE_MS`.
 *
 * It lives in `platform` rather than beside the key bindings that first needed it because it is
 * entirely a process/environment concern: one variable read, one number out, nothing about the
 * terminal. `platform/update.ts` opens its own readline for the update prompt and needs the same
 * figure, and `platform` may not import `terminal` — reaching upward for a constant is exactly the
 * inversion the layering guard exists to catch. `terminal/keybindings.ts` re-exports both names, so
 * every existing importer is unaffected.
 */
export const DEFAULT_ESCAPE_CODE_TIMEOUT_MS = 50;

export function escapeCodeTimeoutMs(environment: Record<string, string | undefined> = process.env): number {
  const raw = environment.ARCHYMEDES_ESCAPE_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 10 && parsed <= 2_000 ? parsed : DEFAULT_ESCAPE_CODE_TIMEOUT_MS;
}
