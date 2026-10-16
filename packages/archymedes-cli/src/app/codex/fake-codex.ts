import type { CodexTransport, JsonRpcMessage } from "./rpc";

/**
 * A stand-in for `codex app-server`, for tests: answers the requests a session makes and plays a
 * scripted turn as Codex's notifications, the shapes recorded from a live run of Codex 0.160.0.
 * A step may ask for approval (and wait for the answer), hang until interrupted, or crash.
 */

export type FakeStep =
  | { notify: string; params: Record<string, unknown> }
  | { ask: string; params: Record<string, unknown> }
  | { hang: true }
  | { crash: string };

export type FakeScript = (prompt: string, turn: number) => FakeStep[];

export class FakeCodex {
  readonly requests: JsonRpcMessage[] = [];
  readonly answers: unknown[] = [];
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  starts = 0;
  interrupts = 0;
  /** Thread ids `thread/resume` refuses, as Codex does for a thread it no longer has. */
  readonly unknownThreads = new Set<string>();
  failInitialize?: string;
  private turns = 0;
  private threads = 0;

  constructor(public script: FakeScript) {}

  /** One process's stdio: a session asks for a new one after each crash. */
  transport = (): CodexTransport & { stderr: () => string } => {
    this.starts += 1;
    const lines: Array<(line: string) => void> = [];
    const exits: Array<(reason: string) => void> = [];
    let alive = true;
    let interrupt: (() => void) | undefined;
    // An interrupt can arrive before the turn reaches its waiting step; it still stops the turn.
    let interruptedEarly = false;
    let answer: ((id: number, result: unknown) => void) | undefined;
    const say = (message: JsonRpcMessage) => {
      if (!alive) return;
      queueMicrotask(() => { if (alive) for (const listener of lines) listener(JSON.stringify(message)); });
    };
    const die = (reason: string) => {
      if (!alive) return;
      alive = false;
      for (const listener of exits) listener(reason);
    };
    let serverId = 1000;
    const pendingAnswers = new Map<number, (result: unknown) => void>();
    answer = (id, result) => pendingAnswers.get(id)?.(result);
    const play = async (threadId: string, turnId: string, prompt: string) => {
      const steps = this.script(prompt, this.turns);
      for (const step of steps) {
        if (!alive) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if ("notify" in step) say({ method: step.notify, params: { threadId, turnId, ...step.params } });
        else if ("ask" in step) {
          const id = serverId++;
          const reply = new Promise<unknown>((resolve) => pendingAnswers.set(id, resolve));
          say({ jsonrpc: "2.0", id, method: step.ask, params: { threadId, turnId, ...step.params } });
          this.answers.push(await reply);
        } else if ("hang" in step) {
          if (!interruptedEarly) await new Promise<void>((resolve) => { interrupt = resolve; });
          interruptedEarly = false;
          say({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [], error: null } } });
          return;
        } else {
          die(step.crash);
          return;
        }
      }
    };
    return {
      write: (line) => {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.method === undefined && typeof message.id === "number") return answer?.(message.id, message.result ?? { error: message.error });
        this.requests.push(message);
        if (message.id === undefined) return; // a notification ("initialized")
        const params = (message.params ?? {}) as Record<string, unknown>;
        const respond = (result: unknown) => say({ jsonrpc: "2.0", id: message.id, result });
        const refuse = (text: string) => say({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: text } });
        switch (message.method) {
          case "initialize":
            return this.failInitialize ? refuse(this.failInitialize) : respond({ userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" });
          case "thread/start":
            this.threads += 1;
            return respond({ thread: { id: `thread-${this.threads}` }, model: String(params.model ?? "gpt-5.6-luna") });
          case "thread/resume":
            return this.unknownThreads.has(String(params.threadId)) ? refuse(`no rollout found for thread id ${params.threadId}`) : respond({ thread: { id: params.threadId }, model: "gpt-5.6-luna" });
          case "model/list":
            return respond({ data: [{ id: "gpt-5.6-luna" }, { id: "gpt-6-luna" }, { id: "hidden-one", hidden: true }] });
          case "turn/start": {
            this.turns += 1;
            const input = (params.input as Array<{ text: string }>)[0]?.text ?? "";
            this.prompts.push(input);
            const turnId = `turn-${this.turns}`;
            respond({ turn: { id: turnId, status: "inProgress", items: [] } });
            void play(String(params.threadId), turnId, input);
            return;
          }
          case "turn/interrupt":
            this.interrupts += 1;
            respond({});
            if (interrupt) interrupt();
            else interruptedEarly = true;
            interrupt = undefined;
            return;
          case "turn/steer":
            this.steers.push((params.input as Array<{ text: string }>)[0]?.text ?? "");
            return respond({ turnId: params.expectedTurnId });
          case "thread/compact/start":
            return respond({});
          default:
            return refuse(`unknown method ${message.method}`);
        }
      },
      onLine: (listener) => { lines.push(listener); },
      onExit: (listener) => { exits.push(listener); },
      close: () => die("closed"),
      stderr: () => "fake stderr line",
    };
  };
}

/** The notifications of a reply that streams `text`, uses `usage` tokens, and completes. */
export function replyWith(text: string, options: { final?: boolean } = {}): FakeStep[] {
  const id = `msg-${text.length}-${text.slice(0, 5)}`;
  return [
    { notify: "item/started", params: { item: { type: "agentMessage", id, text: "", phase: options.final === false ? "commentary" : "final_answer" } } },
    { notify: "item/agentMessage/delta", params: { itemId: id, delta: text } },
    { notify: "item/completed", params: { item: { type: "agentMessage", id, text, phase: options.final === false ? "commentary" : "final_answer" } } },
    { notify: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, totalTokens: 110, reasoningOutputTokens: 2, cacheWriteInputTokens: 0 }, modelContextWindow: 258400 } } },
  ];
}

export function completed(status = "completed", error?: string): FakeStep {
  return { notify: "turn/completed", params: { turn: { status, items: [], error: error ? { message: error } : null } } };
}

export function command(id: string, commandLine: string, output: string, exitCode = 0): FakeStep[] {
  const item = { type: "commandExecution", id, command: `/bin/bash -lc "${commandLine.replace(/"/g, '\\"')}"`, cwd: "/work/project", status: "inProgress", aggregatedOutput: null, exitCode: null };
  return [
    { notify: "item/started", params: { item } },
    { notify: "item/completed", params: { item: { ...item, status: "completed", aggregatedOutput: output, exitCode } } },
  ];
}

export function fileChange(id: string, file: string, diff: string, status = "completed"): FakeStep[] {
  const changes = [{ path: file, kind: { type: "update", move_path: null }, diff }];
  return [
    { notify: "item/started", params: { item: { type: "fileChange", id, changes, status: "inProgress" } } },
    { notify: "item/completed", params: { item: { type: "fileChange", id, changes, status } } },
  ];
}
