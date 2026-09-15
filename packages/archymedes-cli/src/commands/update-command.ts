import type { GlyphSet } from "../text/glyphs";

type Paint = (text: string) => string;
export type AutoUpdatePolicy = "install" | "check" | "off";

export type UpdateCommandContext = {
  currentVersion: string;
  fetchLatest(): Promise<string | undefined>;
  compareVersions(current: string, latest: string): number;
  /** Persists the auto-update policy; false when settings cannot be written. */
  savePolicy(mode: AutoUpdatePolicy): Promise<boolean>;
  confirm(question: string): Promise<boolean>;
  runUpdate(write: (text: string) => void, warn: (text: string) => void): Promise<{ status: string; latestVersion?: string }>;
  write(text: string): void;
  paint: { dim: Paint; yellow: Paint; green: Paint; bold: Paint };
  glyphs: GlyphSet;
};

/** `/update auto|check|off` sets the policy; `/update` on its own checks and, with consent, installs. */
export function parseUpdatePolicy(argument: string): AutoUpdatePolicy | undefined {
  if (argument === "auto" || argument === "install" || argument === "on") return "install";
  if (argument === "off" || argument === "never") return "off";
  if (argument === "check" || argument === "notify") return "check";
  return undefined;
}

export async function runUpdateCommand(argument: string, context: UpdateCommandContext): Promise<void> {
  const { paint, write, glyphs, currentVersion } = context;
  const ok = paint.green(glyphs.check);
  if (argument) {
    const mode = parseUpdatePolicy(argument);
    if (!mode) { write(paint.yellow("  Say /update auto, /update check or /update off — or /update on its own to install now.\n")); return; }
    const saved = await context.savePolicy(mode);
    const described = mode === "install" ? "check daily and install automatically" : mode === "check" ? "check daily and tell you" : "never check for updates";
    write(`  ${ok} Archymedes will ${described}.${saved ? "" : paint.dim(" (not saved — settings are read-only here)")}\n`);
    return;
  }
  write(paint.dim(`  checking for a newer Archymedes than ${currentVersion}…\n`));
  const latest = await context.fetchLatest();
  if (!latest) { write(paint.yellow("  Could not reach the registry. Nothing was changed.\n")); return; }
  const order = context.compareVersions(currentVersion, latest);
  if (order === 0) { write(`  ${ok} Already on the newest version (${latest}).\n`); return; }
  if (order > 0) { write(`  ${ok} This Archymedes (${currentVersion}) is newer than the registry release (${latest}); no downgrade offered.\n`); return; }
  if (!(await context.confirm(`Install Archymedes ${paint.bold(latest)}, replacing ${currentVersion}?`))) { write(paint.dim("  Left as it is.\n")); return; }
  const result = await context.runUpdate(write, (text) => write(paint.yellow(text)));
  write(result.status === "updated"
    ? `  ${ok} Updated to ${result.latestVersion}. This session keeps running ${currentVersion} until you restart.\n`
    : paint.yellow(`  Update did not complete (${result.status}).\n`));
}
