import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { splitFrames } from "../platform/ndjson";

/**
 * `friday acp` as a child process, with the handshake a client owes it done here.
 *
 * The phone is the person's client, but it comes and goes: it is asleep for most of a session's
 * life. The agent needs a client that is always there to have started at all, so the bridge does
 * the `initialize` and `session/new` itself and hands the phone an agent that is already open.
 * After that it is a pipe: whatever the agent writes goes out as a frame, whatever arrives goes in.
 *
 * Ids: the bridge's own requests are `b1`, `b2`, … and their answers never leave this file. The
 * phone's are `p…` and the agent's own requests (an approval) use its numbers, so none collide.
 */

export const ACP_PROTOCOL_VERSION = 1;

export type SessionInfo = { sessionId: string; mode?: string; model?: string; provider?: string };

export type HostOptions = {
  /** The agent's command line, e.g. `["friday", "acp"]`. */
  command: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** One JSON-RPC message from the agent, as the line it wrote. */
  onFrame: (line: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Diagnostics from the agent's stderr, never part of the protocol. */
  onStderr?: (text: string) => void;
  /** Where the agent's session id is kept, so a restarted agent continues the same conversation. */
  statePath?: string;
  spawn?: typeof nodeSpawn;
  /** How long the agent has to answer a handshake request. */
  timeoutMs?: number;
};

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class AcpHost {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private next = 1;
  private readonly pending = new Map<string, Pending>();
  private stopped = false;

  constructor(private readonly options: HostOptions) {}

  /** Starts the agent and opens (or resumes) its session. Rejects if the agent does not come up. */
  async start(): Promise<SessionInfo> {
    const [command, ...args] = this.options.command;
    const child = (this.options.spawn ?? nodeSpawn)(command, args, { cwd: this.options.cwd, env: this.options.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.options.onStderr?.(chunk));
    child.stdin.on("error", () => undefined); // a dead agent is reported by `close`, not by a broken pipe
    child.on("close", (code, signal) => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`the agent exited during the handshake (code ${code})`));
      }
      this.pending.clear();
      if (this.child === child) this.child = undefined;
      if (!this.stopped) this.options.onExit(code, signal);
    });
    child.on("error", (error) => {
      for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear();
    });

    const init = await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { _meta: { archymedes: { events: true, questions: true } } },
    });
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error(`the agent speaks ACP ${String(init.protocolVersion)}, the bridge speaks ${ACP_PROTOCOL_VERSION}`);

    const remembered = await this.remembered();
    let opened: Record<string, unknown> | undefined;
    if (remembered) {
      // The same conversation, after the agent restarted. If it cannot be loaded, a new one is better than none.
      opened = await this.request("session/load", { sessionId: remembered, cwd: this.options.cwd, mcpServers: [] }).catch(() => undefined);
      if (opened && typeof opened.sessionId !== "string") opened = { ...opened, sessionId: remembered };
    }
    opened ??= await this.request("session/new", { cwd: this.options.cwd, mcpServers: [] });
    const meta = ((opened._meta as Record<string, unknown> | undefined)?.archymedes ?? {}) as Record<string, unknown>;
    const sessionId = [opened.sessionId, meta.sessionId, remembered].find((value): value is string => typeof value === "string" && value !== "");
    if (!sessionId) throw new Error("the agent opened a session without an id");
    await this.remember(sessionId);
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    return { sessionId, mode: text(meta.mode), model: text(meta.model), provider: text(meta.provider) };
  }

  /** One message for the agent, as a single line. */
  send(frame: string): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(frame.endsWith("\n") ? frame : `${frame}\n`);
  }

  /** Ends the agent for good; `onExit` is not called for it. */
  stop(): void {
    this.stopped = true;
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error("stopped")); }
    this.pending.clear();
    this.child?.kill("SIGTERM");
  }

  private read(chunk: string): void {
    const { messages, rest } = splitFrames(this.buffer + chunk);
    this.buffer = rest;
    for (const line of messages) {
      const answer = this.internalAnswer(line);
      if (!answer) this.options.onFrame(line);
    }
  }

  /** True when the line answered one of the bridge's own requests, which the phone must not see. */
  private internalAnswer(line: string): boolean {
    let message: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof message.id !== "string" || !message.id.startsWith("b") || message.method !== undefined) return false;
    const entry = this.pending.get(message.id);
    if (!entry) return true; // a late answer to a request that timed out: still not for the phone
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(typeof message.error.message === "string" ? message.error.message : "the agent refused"));
    else entry.resolve((message.result ?? {}) as Record<string, unknown>);
    return true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `b${this.next++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the agent did not answer ${method}`));
      }, this.options.timeoutMs ?? 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private async remembered(): Promise<string | undefined> {
    if (!this.options.statePath) return undefined;
    try {
      const saved = JSON.parse(await fs.readFile(this.options.statePath, "utf8")) as { sessionId?: unknown };
      return typeof saved.sessionId === "string" ? saved.sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  private async remember(sessionId: string): Promise<void> {
    if (!this.options.statePath) return;
    await fs.mkdir(path.dirname(this.options.statePath), { recursive: true });
    await fs.writeFile(this.options.statePath, JSON.stringify({ sessionId }));
  }
}
