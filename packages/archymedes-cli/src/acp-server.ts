import { AcpConnection, type AcpSession, type JsonRpcOutgoing } from "@archymedes/core/cli/acp";
import { ArchymedesAgent } from "@archymedes/core/cli/agent";
import { reasoningFromEnvironment } from "@archymedes/core/effort-policy";
import { LocalWorkspace, type ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import { createLspEditDiagnostics } from "@archymedes/core/cli/edit-diagnostics";
import type { ArchymedesMode } from "@archymedes/core/cli/permissions";
import { listSessions, loadSession, type SessionRecord } from "@archymedes/core/cli/session";
import { resolveSessionProvider } from "./app/session-provider";
import { saveSetup, setupStatus } from "./app/acp-setup";
import { modelList } from "./app/acp-models";
import { runSessionCommand } from "./app/acp-commands";
import { listSettings, setSetting } from "./app/acp-settings";
import { installInChildProcess, startupMaintenance } from "./app/startup-update";
import { CostLedger } from "@archymedes/core/cli/cost";
import { jevOptionsFromEnvironment } from "./app/jev";
import { createExaClient } from "@archymedes/core/providers/exa";

/**
 * `archymedes acp` — the same agent, driven by an editor over stdio.
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

/** One `archymedes acp` process: reads until stdin closes, then disposes every live session. */
export async function runAcpServer(options: AcpServerOptions): Promise<number> {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const send = (message: JsonRpcOutgoing) => options.write(`${JSON.stringify(message)}\n`);

  let startup: Promise<string[]> | undefined;
  const connection = new AcpConnection({
    send,
    extensions: {
      "_archymedes/setup/status": async () => setupStatus(options.environment, { provider: options.provider, model: options.model }),
      "_archymedes/setup/save": async (params) => saveSetup(params, { environment: options.environment, processEnvironment: process.env as Record<string, string | undefined> }),
      "_archymedes/settings/list": async () => listSettings(process.env as Record<string, string | undefined>),
      "_archymedes/settings/set": async (params) => setSetting(params, { environment: options.environment, processEnvironment: process.env as Record<string, string | undefined> }),
      "_archymedes/models": async (params) => modelList(options.environment, params),
      // Asked by the Go interface once its session is open: the daily update check and install the
      // terminal CLI runs at startup. Once per process; an editor that never asks never updates.
      "_archymedes/startup": async () => ({
        notices: await (startup ??= startupMaintenance(options.environment, false, installInChildProcess({ execPath: process.execPath, script: process.argv[1] ?? "" }, options.environment))),
      }),
      // Newest first, for a resume picker: id, title and when it was last touched.
      "_archymedes/sessions": async (params) => listSessions(typeof params.cwd === "string" && params.cwd ? params.cwd : options.defaultRoot, 50),
    },
    createSession: async ({ cwd, onEvent, approve, resumeSessionId }): Promise<AcpSession> => {
      const root = cwd || options.defaultRoot;
      const first = await resolveSessionProvider(options.environment, { root, resume: resumeSessionId, provider: options.provider, model: options.model });
      if ("error" in first) throw new Error(first.error);
      let resolved = first;
      // What the session spends, priced in the model's own currency (no FX here: the client
      // shows the provider's figure), recorded turn by turn as the terminal CLI's ledger is.
      const ledger = new CostLedger({ prices: resolved.prices, display: resolved.prices?.currency ?? "USD" });

      // A mode change rebuilds the agent under the new capability set and carries the transcript
      // across, exactly as `/mode` does in the terminal. Anything less would be a lie: plan mode is
      // a mode in which the write tools are not loaded, and that is decided when the tools are built.
      let mode: ArchymedesMode = options.mode ?? "build";
      const started = options.createWorkspace ? await options.createWorkspace() : { workspace: new LocalWorkspace(root) };
      if ("error" in started) throw new Error(started.error);
      const workspace = started.workspace;
      let agent = build(mode);

      function build(currentMode: ArchymedesMode): ArchymedesAgent {
        const built = new ArchymedesAgent({
          root,
          model: resolved.provider,
          prices: priceCatalogFor(resolved.prices),
          mode: currentMode,
          workspace,
          search: createExaClient(options.environment),
          onEvent,
          jev: jevOptionsFromEnvironment(options.environment),
          ...(reasoningFromEnvironment(options.environment) ? { reasoning: reasoningFromEnvironment(options.environment) } : {}),
          // Language-server diagnostics appended to each edit result, as in the terminal session.
          afterEdit: acpEditDiagnostics(root, workspace, options.environment),
          approve: async (request) =>
            approve({ toolName: request.tool.name, summary: request.summary, toolCallId: request.call.id, ...(request.pattern ? { pattern: request.pattern } : {}) }),
        });
        // The interface opens the session well before the first prompt is finished: probe the
        // environment now, so the first turn does not wait ~240 ms on it before its first model call.
        built.warmUp();
        return built;
      }

      async function rebuild(change: () => void): Promise<void> {
        const carried = await loadSession(root, agent.sessionId);
        await agent.relinquish();
        change();
        agent = build(mode);
        if (carried) agent.resume(carried);
      }

      let history: SessionRecord["messages"] = [];
      if (resumeSessionId) {
        // "latest" is the most recent session in this project, as `--resume` means on the command line.
        const id = resumeSessionId === "latest" ? (await listSessions(root, 1))[0]?.id : resumeSessionId;
        const record = id ? await loadSession(root, id) : undefined;
        if (!record) throw new Error(resumeSessionId === "latest" ? `No earlier session in ${root}` : `No stored session ${resumeSessionId} in ${root}`);
        agent.resume(record);
        history = record.messages;
      }

      return {
        get id() { return agent.sessionId; },
        async send(prompt) {
          const started = Date.now();
          const result = await agent.send(prompt);
          ledger.record({ usage: result.usage, iterations: result.iterations, toolCalls: result.toolCallsExecuted, elapsedMs: Date.now() - started });
          return result;
        },
        command: async (command, argument) => runSessionCommand(command, argument, { agent, ledger }),
        cancel: () => agent.cancel(),
        async setMode(next) {
          if (next === mode) return;
          await rebuild(() => { mode = next; });
        },
        // Like a mode change: a new agent on the new model, carrying the transcript across. The
        // choice is checked before anything is torn down, so an unusable model leaves the session as it was.
        async setModel(provider, model) {
          const next = await resolveSessionProvider(options.environment, { root, provider, model });
          if ("error" in next) throw new Error(next.error);
          await rebuild(() => { resolved = next; });
          ledger.setPrices(next.prices);
        },
        dispose: () => agent.dispose(),
        history: () => history,
        info: () => ({ sessionId: agent.sessionId, provider: resolved.spec.id, providerLabel: resolved.spec.label, model: resolved.model, mode, root, workspace: agent.workspaceKind, workspaceLabel: agent.workspaceLabel }),
      };
    },
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
        warn(`archymedes acp: ignoring unparseable message (${line.length} bytes)`);
        continue;
      }
      if (isPrompt(parsed)) {
        const turn: Promise<void> = receive(parsed)
          .catch((error: unknown) => warn(`archymedes acp: turn failed: ${error instanceof Error ? error.message : String(error)}`))
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

/**
 * The `afterEdit` hook for an ACP session: local workspaces only (a server on this machine cannot
 * see a sandbox's files), and `ARCHYMEDES_EDIT_DIAGNOSTICS=off` disables — the same rule
 * `archymedes.ts` applies to the terminal session.
 */
export function acpEditDiagnostics(
  root: string,
  workspace: unknown,
  environment: Record<string, string | undefined>,
): ((path: string) => Promise<string | undefined>) | undefined {
  if (!(workspace instanceof LocalWorkspace)) return undefined;
  if (environment.ARCHYMEDES_EDIT_DIAGNOSTICS?.trim().toLowerCase() === "off") return undefined;
  return createLspEditDiagnostics(root);
}

/**
 * The runtime's integer-unit price guard, from the provider's per-million rates.
 *
 * Deliberately the inexact form: the ACP path has no approved currency budget to enforce, so this
 * is only the runaway ceiling, and a catalog of 1/1 would make that ceiling meaningless.
 */
function priceCatalogFor(prices: { inputPerMillion: number; outputPerMillion: number; largeContext?: { aboveInputTokens: number; inputMultiplier: number; outputMultiplier: number } } | undefined) {
  if (!prices) return { inputRatePerMillion: 1, outputRatePerMillion: 1 };
  return {
    inputRatePerMillion: Math.max(1, Math.round(prices.inputPerMillion / 1_000_000)),
    outputRatePerMillion: Math.max(1, Math.round(prices.outputPerMillion / 1_000_000)),
    ...(prices.largeContext ? { largeContext: prices.largeContext } : {}),
  };
}
