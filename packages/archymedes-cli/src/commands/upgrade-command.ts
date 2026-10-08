import type { ArchymedesSettings } from "../platform/settings";

type Paint = (text: string) => string;

export type UpgradeCommandContext = {
  /** Hidden prompt: a pasted key must never be echoed. */
  askSecret(question: string): Promise<string>;
  write(text: string): void;
  paint: { green: Paint; yellow: Paint; dim: Paint };
};

export type UpgradeCommandDependencies = {
  /** Settings as they are now; the key is added to them, nothing is replaced. */
  settings: ArchymedesSettings;
  /** Saves the merged settings and returns the file they were saved to. */
  save(next: ArchymedesSettings): Promise<string>;
};

export type UpgradeCommandResult = { saved: true; file: string; settings: ArchymedesSettings } | { cancelled: true };

/**
 * `/upgrade` (also accepted as `/upgrades`): switch from the shared free
 * gateway to the user's own OpenRouter API key.
 *
 * The key is prompted for hidden, saved through the ordinary settings
 * mechanism, and never printed, logged or returned in an error. There is no
 * offline way to check a key is real, so the command says it was saved —
 * never that it is valid.
 */
export async function runUpgradeCommand(
  context: UpgradeCommandContext,
  dependencies: UpgradeCommandDependencies,
): Promise<UpgradeCommandResult> {
  const { write, paint } = context;
  write("  Upgrade switches Archymedes from the shared free gateway to your own OpenRouter API key.\n");
  write(`${paint.dim("  Free-mode limits no longer apply; requests go straight to OpenRouter with your key.\n")}`);
  const key = (await context.askSecret("  OpenRouter API key: ")).trim();
  if (!key) {
    write(paint.yellow("  upgrade cancelled — no key was saved\n"));
    return { cancelled: true };
  }
  // Direct-key mode is the ordinary OpenRouter provider on the user's key,
  // so the saved choice outlives this session.
  const settings: ArchymedesSettings = { ...dependencies.settings, OPENROUTER_API_KEY: key, ARCHYMEDES_PROVIDER: "openrouter" };
  const file = await dependencies.save(settings);
  write(paint.green("  Your OpenRouter API key is configured.\n"));
  write(paint.green("  Archymedes is now using direct-key mode.\n"));
  write(paint.dim(`  Saved to ${file}. Free mode stays available with archymedes --free.\n`));
  return { saved: true, file, settings };
}
