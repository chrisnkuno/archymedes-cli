import { isKnownCommand, suggestCommand } from "../catalog/commands";
import { resolvePromptCommand } from "../platform/prompt-commands";

export type SlashInputContext = {
  root: string;
  environment: Record<string, string | undefined>;
  /** Styled by the caller; `dim` for provenance, `warn` for the unknown-command line. */
  dim(text: string): void;
  warn(headline: string, detail: string): void;
};

/**
 * What a typed `/something` that is not a built-in command becomes.
 *
 * A saved prompt (`.archymedes/commands/<name>.md`, or the user's own) resolves to the text to send as
 * the turn, with a dim line naming the file it came from. Anything else is a typo and resolves to
 * undefined after saying so: sending it to the model would cost a round trip to be told it makes no
 * sense. Files that failed to load are listed there too, since a broken file is the usual reason a
 * command someone just wrote is "unknown".
 */
export async function resolveSlashInput(input: string, context: SlashInputContext): Promise<string | undefined> {
  const name = input.split(/\s+/)[0];
  const custom = await resolvePromptCommand(input, context.root, context.environment, isKnownCommand);
  if ("prompt" in custom) {
    context.dim(`  ${name} · ${custom.command.source} command · ${custom.command.path}`);
    return custom.prompt;
  }
  const suggestion = suggestCommand(name);
  const detail = [
    suggestion ? ` Did you mean ${suggestion}?` : " Type /help for the list.",
    custom.names.length ? ` Custom: ${custom.names.join(", ")}.` : "",
    ...custom.problems.map((problem) => `\n  ${problem}`),
  ].join("");
  context.warn(`Unknown command ${name}.`, detail);
  return undefined;
}
