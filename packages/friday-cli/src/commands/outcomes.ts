/**
 * `friday outcomes on|off|status|preview` — the only switch for opt-in outcome reporting.
 * What is collected and how it travels is in platform/outcomes.ts and platform/outcome-reporting.ts.
 */
import { EXIT_CODES } from "../cli/exit-codes";
import {
  OUTCOME_BATCH_LIMIT,
  outcomeNetworkBlocked,
  outcomesEndpoint,
  previewOutcomes,
  readOutcomeQueue,
  readOutcomeState,
  setOutcomeReporting,
  type OutcomeDependencies,
} from "../platform/outcome-reporting";

export type OutcomesCommand = { kind: "on" | "off" | "status" | "preview" } | { kind: "invalid"; reason: string };

export function parseOutcomesCommand(words: readonly string[]): OutcomesCommand {
  const [word, extra] = words;
  if (extra !== undefined) return { kind: "invalid", reason: "friday outcomes takes one word: on, off, status or preview" };
  if (word === undefined) return { kind: "status" };
  if (word === "on" || word === "off" || word === "status" || word === "preview") return { kind: word };
  return { kind: "invalid", reason: `Unknown outcomes command "${word}". Use on, off, status or preview.` };
}

export type OutcomesIo = OutcomeDependencies & { write: (text: string) => void };

export async function runOutcomesCommand(command: OutcomesCommand, io: OutcomesIo): Promise<number> {
  const { write, environment } = io;
  if (command.kind === "invalid") {
    write(`${command.reason}\n`);
    return EXIT_CODES.usage;
  }
  const blocked = outcomeNetworkBlocked(environment);
  const endpoint = outcomesEndpoint(environment);
  if (command.kind === "on") {
    const state = await setOutcomeReporting(true, io);
    write([
      `Outcome reporting is on (since ${state.grantedAt}).`,
      "Each finished task adds one anonymous event: engine, provider, model id, effort, counts, buckets and",
      "exit status. Never prompts, code, paths, repository or file names, or error text.",
      endpoint ? `Sent in batches to ${endpoint}/v1/outcomes.` : "ARCHYMEDES_OUTCOMES_URL is not set, so nothing is sent yet; events wait in a local queue.",
      ...(blocked ? [`Nothing is recorded or sent while ${blocked}.`] : []),
      "See exactly what would be sent: friday outcomes preview. Turn off (and erase): friday outcomes off.",
      "",
    ].join("\n"));
    return 0;
  }
  if (command.kind === "off") {
    const state = await setOutcomeReporting(false, io);
    write([
      "Outcome reporting is off. The local queue is cleared and this install has a new id.",
      state.pendingErasure.length === 0
        ? "Erasure of everything sent under the previous id was requested and accepted."
        : `Erasure requested; ${state.pendingErasure.length} request(s) could not be delivered yet and will be retried on a later run.`,
      "",
    ].join("\n"));
    return 0;
  }
  if (command.kind === "preview") {
    const preview = await previewOutcomes(io);
    write(`${preview.sample ? "Nothing is queued; a sample of one event" : `The next batch (up to ${OUTCOME_BATCH_LIMIT} events)`}, exactly as it would be sent to ${preview.url ?? "ARCHYMEDES_OUTCOMES_URL (not set: nothing would be sent)"}:\n`);
    write(`${JSON.stringify(preview.body, null, 2)}\n`);
    return 0;
  }
  const state = await readOutcomeState(io);
  const queued = (await readOutcomeQueue(io)).length;
  write([
    `Outcome reporting: ${state.enabled ? `on (since ${state.grantedAt})` : "off (the default)"}`,
    `Install id: ${state.enabled ? state.installId : "none in use"}`,
    `Destination: ${endpoint ? `${endpoint}/v1/outcomes` : "none (ARCHYMEDES_OUTCOMES_URL not set)"}`,
    `Queued: ${queued}`,
    ...(blocked ? [`Blocked: ${blocked}`] : []),
    ...(state.pendingErasure.length > 0 ? [`Erasure requests waiting to be delivered: ${state.pendingErasure.length}`] : []),
    "",
  ].join("\n"));
  return 0;
}
