/**
 * The two ways a session starts somewhere other than an empty prompt: `--resume`, and a request
 * passed on the command line, which runs one turn and exits.
 *
 * Moved out of `main()` unchanged. Each returns the process exit code when the session ends here.
 */
import path from "node:path";
import { downloadProject } from "@archymedes/core/cli/backends";
import { listSessions, loadSession } from "@archymedes/core/cli/session";
import { EXIT_CODES, exitCodeForStatus, type HeadlessEmitter } from "../headless";
import { renderReplay } from "../commands/chat-history";
import type { CliStateHistory } from "../session/state-history";
import type { OpenClient } from "./agent-factory";
import type { ParsedArgs } from "./args";
import type { SessionState } from "./session-state";
import { out, sectionStyle, style } from "./transcript";

type StartContext = {
  args: ParsedArgs;
  interactive: boolean;
  stateHistory: CliStateHistory;
  state: SessionState;
  openClient: OpenClient;
  exitCleanly: () => void;
};

/** `--resume [id|latest]`: swaps the fresh client for one opened against the saved session. */
export async function resumeAtStartup(context: StartContext & { carryResumedSpend: (record: NonNullable<Awaited<ReturnType<typeof loadSession>>>) => Promise<void> }): Promise<number | undefined> {
  const { args, interactive, stateHistory, state, openClient } = context;
  if (!args.resume) return undefined;
  let record: Awaited<ReturnType<typeof loadSession>> = null;
  if (args.resume === "latest") {
    // The newest chat *this project* can load: an index row whose snapshot names another root (or
    // is gone) is skipped rather than ending the search, so another project's chat is never resumed.
    const indexed = await stateHistory.sessions(5);
    const ids = indexed && indexed.length > 0 ? indexed.map((session) => session.sessionId) : (await listSessions(args.root, 5)).map((session) => session.id);
    for (const candidate of ids) {
      record = await loadSession(args.root, candidate).catch(() => null);
      if (record) break;
    }
  } else {
    record = await loadSession(args.root, args.resume);
  }
  if (record) {
    // The daemon resumes at construction, not in place — swap the fresh client already opened
    // above for one opened against the resumed record, the same handoff every mode/model switch
    // below performs.
    await state.agent.relinquish();
    if (record.mode && !args.modeExplicit) state.mode = record.mode;
    state.agent = await openClient(record);
    await context.carryResumedSpend(state.agent.snapshot());
    out.write(style.dim(`Resumed ${record.id} — ${record.title}\n`));
    // Where the conversation actually got to, not just its id. A resumed session that opens on
    // an empty screen asks the user to trust that a transcript they cannot see is loaded, and
    // the usual next move — scroll back to check — has nothing to scroll to.
    //
    // Only when this run will actually stop at a prompt. A replay is orientation for someone
    // about to type; in front of a one-shot answer it is preamble nobody is waiting for, and
    // `archymedes --resume "…"` from a terminal is still a one-shot even though the terminal is real.
    if (interactive && !args.prompt) out.write(`${renderReplay(state.agent.snapshot(), sectionStyle(), { turns: 2 })}\n`);
  } else if (args.resume === "latest") {
    out.write(style.yellow("No matching session; starting a new one.\n"));
  } else {
    // An explicit id is a request for *that* conversation. Starting a fresh one instead looks
    // identical for the first few seconds and then diverges silently — the work lands in a new
    // session while the user believes they are adding to the old one. A mistyped id is far
    // cheaper to be told about now.
    process.stderr.write(`${style.red(`No session ${args.resume} in this project.`)} Run archymedes --sessions to list them.\n`);
    await state.agent.dispose();
    await stateHistory.close();
    context.exitCleanly();
    return EXIT_CODES.usage;
  }
  return undefined;
}

/** A request on the command line: one turn, then exit with its outcome. */
export async function runOneShot(context: StartContext & {
  prompt: string;
  headless: HeadlessEmitter | null;
  runTurn: (request: string) => Promise<boolean>;
}): Promise<number> {
  const { args, stateHistory, state, prompt } = context;
  if (prompt.trimStart().startsWith("/")) {
    // A one-shot argument is an objective, not an interactive input queue. Sending a slash
    // command to the model is the costly failure mode: it spends tokens trying to interpret a
    // local control it can never execute. Fail before estimation or provider contact instead.
    process.stderr.write(`Slash commands run inside an interactive Archymedes session. Start archymedes, then type ${prompt.trim()}.\n`);
    await state.agent.dispose();
    await stateHistory.close();
    context.exitCleanly();
    return EXIT_CODES.usage;
  }
  // Announced before any work, so a consumer knows what it is reading before the first event.
  context.headless?.session({
    sessionId: state.agent.sessionId,
    root: args.root,
    provider: state.spec.id,
    model: state.resolvedModelId,
    mode: state.mode,
    workspace: state.agent.workspaceLabel,
  });
  const ran = await context.runTurn(prompt);
  // A one-shot run against a sandbox would otherwise leave the work unreachable, so it is
  // offered back before the sandbox goes away.
  if (ran && state.workspace.kind === "e2b") {
    const destination = path.resolve(args.root, "archymedes-pull");
    const pulled = await downloadProject(state.workspace, destination);
    out.write(style.dim(`  pulled ${pulled.written.length} files into ${destination}\n`));
  }
  await state.agent.dispose();
  await stateHistory.close();
  context.exitCleanly();
  // Headless callers get the specific outcome; the human path keeps its long-standing 0/1.
  return args.json ? exitCodeForStatus(state.lastTurnStatus) : (ran ? 0 : 1);
}
