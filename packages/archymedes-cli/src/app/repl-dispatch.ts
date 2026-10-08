/**
 * The REPL's slash-command dispatch, in the order the loop has always tried them.
 *
 * Each group may answer a line (`continue` or `break`) or hand it on, possibly rewritten — `/retry`
 * becomes the failed request, `/wander` becomes the lab prompt, a saved prompt becomes its text —
 * to the next group and finally to the model as a turn.
 */
import type { ReplContext, SlashOutcome } from "./repl-context";
import { dispatchSessionCommand } from "./repl-session-commands";
import { dispatchViewCommand } from "./repl-view-commands";
import { dispatchWorkCommand } from "./repl-work-commands";

const GROUPS = [dispatchSessionCommand, dispatchViewCommand, dispatchWorkCommand] as const;

export async function dispatchSlashCommand(input: string, context: ReplContext): Promise<SlashOutcome> {
  let line = input;
  for (const dispatch of GROUPS) {
    const outcome = await dispatch(line, context);
    if (outcome === "continue" || outcome === "break") return outcome;
    line = outcome.input;
  }
  return { input: line };
}
