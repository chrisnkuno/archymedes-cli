import { AcpConnection, type AcpSession, type JsonRpcOutgoing } from "@archymedes/core/cli/acp";
import type { ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import type { ArchymedesMode } from "@archymedes/core/cli/permissions";
import { listSessions } from "@archymedes/core/cli/session";
import { saveSetup, setupStatus, providerOverview } from "./app/acp-setup";
import { modelList } from "./app/acp-models";
import { listSettings, setSetting } from "./app/acp-settings";
import { connectProvider, providerModels, rememberModel } from "./app/acp-connect";
import { openSession, withOpenElsewhere } from "./app/acp-session";
import { claudeModels, claudeOverview, connectClaude, rememberClaudeModel } from "./app/claude/backend";
import { claudeSetupStatus, withClaude, withClaudeModels } from "./app/claude/listing";
import { CLAUDE_PROVIDER } from "./app/claude/identity";
import { codexModels, codexOverview, codexSetupStatus, connectCodex, rememberCodexModel, withCodex, withCodexModels } from "./app/codex/backend";
import { CODEX_PROVIDER } from "./app/codex/identity";
import { installInChildProcess, startupMaintenance } from "./app/startup-update";

/**
 * `friday acp` — the same agent, driven by an editor over stdio.
 *
 * Nothing about a Archymedes session is terminal-shaped underneath: a turn already emits structured
 * events and already pauses on an approval that somebody else answers. What the terminal front end
 * adds is rendering and a human. ACP replaces both with an editor, and this file is only the
 * plumbing that lets it — framing on the wire, a session factory, and the mapping from Archymedes's
 * approval decisions to the option list a client shows.
 *
 * Line-delimited JSON, one complete message per line, in both directions. Nothing else may ever be
 * written to stdout while this is running: a stray banner or a progress spinner is a parse error at
 * the other end, and the client has no way to resynchronize. Diagnostics go to stderr.
 */

/**
 * Splits a stdio chunk into complete messages, keeping whatever is left over.
 *
 * Pure and separate from the stream because this is where a naive implementation breaks in
 * production and nowhere else: a large `session/prompt` arrives in several chunks, and a reader
 * that assumes one chunk is one message loses the tail of every big paste. Blank lines are skipped
 * rather than treated as empty messages, which is what a client that pretty-prints its framing
 * produces.
 */
export function splitFrames(buffer: string): { messages: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { messages: parts.map((line) => line.trim()).filter((line) => line.length > 0), rest };
}

export type AcpServerOptions = {
  provider?: string;
  model?: string;
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  environment: Record<string, string | undefined>;
  defaultRoot: string;
  /** Human-readable diagnostics, never on the protocol channel. */
  warn?: (message: string) => void;
  mode?: ArchymedesMode;
  /**
   * Where a session's work runs: `--sandbox docker|e2b` from the command line. Built once per
   * session and kept across mode and model changes. Must not write to stdout — that is the
   * protocol channel. Absent: the session's own directory, locally.
   */
  createWorkspace?: () => Promise<{ workspace: ArchymedesWorkspace } | { error: string }>;
};

/** One `friday acp` process: reads until stdin closes, then disposes every live session. */
export async function runAcpServer(options: AcpServerOptions): Promise<number> {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const send = (message: JsonRpcOutgoing) => options.write(`${JSON.stringify(message)}\n`);

  let startup: Promise<string[]> | undefined;
  const claude = { environment: options.environment, processEnvironment: process.env as Record<string, string | undefined> };
  const connection = new AcpConnection({
    send,
    extensions: {
      // Claude (the person's own Claude Code) is answered beside the model providers: see app/claude.
      // Claude and Codex (the person's own Claude Code and Codex) are answered beside the model
      // providers: see app/claude and app/codex.
      "_archymedes/providers": async () => {
        const [claudeRow, codexRow] = await Promise.all([claudeOverview(claude), codexOverview(claude)]);
        return { providers: withCodex(withClaude(providerOverview(options.environment), claudeRow), codexRow) };
      },
      "_archymedes/providers/connect": async (params) =>
        params.provider === CLAUDE_PROVIDER ? connectClaude(claude)
          : params.provider === CODEX_PROVIDER ? connectCodex(claude)
            : connectProvider(params, { environment: options.environment, processEnvironment: process.env as Record<string, string | undefined> }),
      "_archymedes/providers/models": async (params) =>
        params.provider === CLAUDE_PROVIDER ? { models: claudeModels() }
          : params.provider === CODEX_PROVIDER ? { models: codexModels() }
            : providerModels(params, { environment: options.environment }),
      "_archymedes/providers/remember-model": async (params) => {
        const model = typeof params.model === "string" ? params.model : "";
        if (params.provider === CLAUDE_PROVIDER) return rememberClaudeModel(model, claude);
        if (params.provider === CODEX_PROVIDER) return rememberCodexModel(model, claude);
        return rememberModel(params, { environment: options.environment, processEnvironment: process.env as Record<string, string | undefined> });
      },
      "_archymedes/setup/status": async () => codexSetupStatus(await claudeSetupStatus(setupStatus(options.environment, { provider: options.provider, model: options.model }), options, claude), options, claude),
      "_archymedes/setup/save": async (params) => saveSetup(params, { environment: options.environment, processEnvironment: process.env as Record<string, string | undefined> }),
      "_archymedes/settings/list": async () => listSettings(process.env as Record<string, string | undefined>),
      "_archymedes/settings/set": async (params) => setSetting(params, { environment: options.environment, processEnvironment: process.env as Record<string, string | undefined> }),
      "_archymedes/models": async (params) => {
        const [listing, claudeRow, codexRow] = await Promise.all([modelList(options.environment, params), claudeOverview(claude), codexOverview(claude)]);
        return withCodexModels(withClaudeModels(listing, claudeRow), codexRow);
      },
      // Asked by the Go interface once its session is open: the daily update check and install the
      // terminal CLI runs at startup. Once per process; an editor that never asks never updates.
      "_archymedes/startup": async () => ({
        notices: await (startup ??= startupMaintenance(options.environment, false, installInChildProcess({ execPath: process.execPath, script: process.argv[1] ?? "" }, options.environment))),
      }),
      // Newest first, for a resume picker: id, title and when it was last touched.
      // Each marked when another terminal has it open: resuming that one opens a copy.
      "_archymedes/sessions": async (params) => {
        const root = typeof params.cwd === "string" && params.cwd ? params.cwd : options.defaultRoot;
        return withOpenElsewhere(root, await listSessions(root, 50));
      },
    },
    createSession: async ({ cwd, onEvent, approve, ask, resumeSessionId }): Promise<AcpSession> =>
      openSession({
        root: cwd || options.defaultRoot,
        environment: options.environment,
        provider: options.provider,
        model: options.model,
        mode: options.mode ?? "build",
        onEvent,
        approve,
        ...(ask ? { ask } : {}),
        createWorkspace: options.createWorkspace,
        warn,
      }, resumeSessionId),
  });

  try {
    const { drain } = await pumpMessages(options.input, (message) => connection.receive(message), warn);
    // The client is gone: nobody can answer a permission request now, so each one waiting is a
    // refusal. Turns still running then finish (a piped one-shot prompt completes) before disposal.
    connection.endOfInput();
    await drain();
    return 0;
  } finally {
    await connection.dispose();
  }
}

/**
 * Reads messages off the input and hands each to `receive`, in order.
 *
 * In order, but not one at a time: `session/prompt` runs a whole turn, and while it runs the same
 * pipe carries the answers the turn is waiting for — a `session/request_permission` reply, a
 * `session/cancel`. Awaiting the prompt before reading on deadlocked every turn that needed an
 * approval and made cancel unreachable. A prompt therefore runs in the background; every other
 * message is still awaited, so `session/new` completes before a prompt that names its session.
 *
 * Resolves when the input ends, with `drain`, which waits for the turns still running.
 */
export async function pumpMessages(
  input: NodeJS.ReadableStream,
  receive: (message: unknown) => Promise<void>,
  warn: (message: string) => void,
): Promise<{ drain: () => Promise<void> }> {
  const inFlight = new Set<Promise<void>>();
  let buffer = "";
  input.setEncoding?.("utf8");
  for await (const chunk of input as AsyncIterable<string>) {
    buffer += chunk;
    const framed = splitFrames(buffer);
    buffer = framed.rest;
    for (const line of framed.messages) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Unparseable input has no id to answer, so there is nobody to send an error to. Say so
        // on stderr and keep reading: one bad line must not end the session.
        warn(`friday acp: ignoring unparseable message (${line.length} bytes)`);
        continue;
      }
      if (isPrompt(parsed)) {
        const turn: Promise<void> = receive(parsed)
          .catch((error: unknown) => warn(`friday acp: turn failed: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => inFlight.delete(turn));
        inFlight.add(turn);
      } else {
        await receive(parsed);
      }
    }
  }
  return {
    drain: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

function isPrompt(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { method?: unknown }).method === "session/prompt";
}

export { acpEditDiagnostics } from "./app/acp-session";
