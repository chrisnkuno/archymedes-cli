/**
 * The bridge's connection to its session's Durable Object: dial out, say hello, carry frames both
 * ways, and come back by itself.
 *
 * Three things make this more than a WebSocket:
 *
 * - **Pause.** A paused sandbox is a snapshot: its sockets are dead on arrival when it resumes, and
 *   nothing tells the process. So liveness is a heartbeat the server answers without waking (a literal
 *   `{"t":"ping"}` earns a literal `{"t":"pong"}`), and a missed pong drops the socket and redials.
 *   A new secret from the server (it writes a new config file on resume) redials at once.
 * - **The gap.** While there is no connection the agent keeps working, so its frames wait here, in
 *   order, up to a bound, and go out after the next hello. Past the bound the oldest are dropped and
 *   the count is reported, so the person is told rather than shown a transcript with a hole.
 * - **Backoff.** A server that is down is not hammered: 0.5 s doubling to 15 s, with jitter.
 */

export type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type SocketFactory = (url: string, init: { headers: Record<string, string> }) => SocketLike;

export type ControlResult = { ok: boolean; detail?: unknown };

export type RelayOptions = {
  socket: SocketFactory;
  /** What to say first on every connection: the agent's session and what it is running. */
  hello: () => Record<string, unknown>;
  /** A frame from the phone, for the agent. */
  onFrame: (line: string) => void;
  /** A housekeeping request from the server (clone, push, …). */
  onControl: (op: string, args: Record<string, unknown>) => Promise<ControlResult>;
  /** The server ended the session. */
  onBye: (reason: string) => void;
  log?: (message: string) => void;
  /** Frames kept while disconnected. */
  maxBuffered?: number;
  heartbeatMs?: number;
  pongTimeoutMs?: number;
  random?: () => number;
};

const PING = '{"t":"ping"}';
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export class Relay {
  private config: { url: string; secret: string } | undefined;
  private socket: SocketLike | undefined;
  private open = false;
  private attempts = 0;
  private redial: ReturnType<typeof setTimeout> | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;
  private pongBy: ReturnType<typeof setTimeout> | undefined;
  private readonly buffered: string[] = [];
  private dropped = 0;
  private closed = false;

  constructor(private readonly options: RelayOptions) {}

  /** The address and secret to use; connects, or reconnects when they changed. */
  setConfig(config: { url: string; secret: string }): void {
    if (this.config?.url === config.url && this.config.secret === config.secret) return;
    this.config = config;
    this.attempts = 0;
    if (this.redial) clearTimeout(this.redial);
    this.redial = undefined;
    this.drop("new configuration");
    this.connect();
  }

  /** One frame from the agent, for the phone. Kept in order if there is no connection. */
  send(line: string): void {
    const frame = parse(line);
    if (frame === undefined) return;
    if (this.open) {
      this.socket?.send(JSON.stringify({ t: "frame", frame }));
      return;
    }
    this.buffered.push(line);
    const bound = this.options.maxBuffered ?? 5_000;
    while (this.buffered.length > bound) {
      this.buffered.shift();
      this.dropped += 1;
    }
  }

  /** Says hello again on the open connection: the agent restarted and the phone should hear what it is now. */
  announce(): void {
    if (this.open) this.socket?.send(JSON.stringify({ t: "hello", ...this.options.hello() }));
  }

  get connected(): boolean {
    return this.open;
  }

  close(): void {
    this.closed = true;
    if (this.redial) clearTimeout(this.redial);
    this.drop("closing");
  }

  private connect(): void {
    if (this.closed || !this.config) return;
    const { url, secret } = this.config;
    let socket: SocketLike;
    try {
      socket = this.options.socket(url, { headers: { Authorization: `Bearer ${secret}` } });
    } catch (error) {
      this.options.log?.(`could not dial: ${error instanceof Error ? error.message : String(error)}`);
      this.later();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.attempts = 0;
      socket.send(JSON.stringify({ t: "hello", ...this.options.hello(), ...(this.dropped > 0 ? { dropped: this.dropped } : {}) }));
      this.dropped = 0;
      for (const line of this.buffered.splice(0)) {
        const frame = parse(line);
        if (frame !== undefined) socket.send(JSON.stringify({ t: "frame", frame }));
      }
      this.startBeat();
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    const gone = () => {
      if (this.socket !== socket) return;
      this.options.log?.("connection lost");
      this.drop("lost");
      this.later();
    };
    socket.onclose = gone;
    socket.onerror = gone;
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    if (this.pongBy) {
      clearTimeout(this.pongBy);
      this.pongBy = undefined;
    }
    const message = parse(data) as { t?: unknown; frame?: unknown; id?: unknown; op?: unknown; args?: unknown; reason?: unknown } | undefined;
    if (!message || typeof message !== "object") return;
    if (message.t === "frame" && message.frame !== undefined) this.options.onFrame(JSON.stringify(message.frame));
    else if (message.t === "bye") this.options.onBye(typeof message.reason === "string" ? message.reason : "ended");
    else if (message.t === "control" && typeof message.id === "string" && typeof message.op === "string") {
      const id = message.id;
      const args = typeof message.args === "object" && message.args !== null ? (message.args as Record<string, unknown>) : {};
      void this.options.onControl(message.op, args).then(
        (result) => this.reply({ t: "result", id, ...result }),
        (error: unknown) => this.reply({ t: "result", id, ok: false, detail: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  private reply(message: Record<string, unknown>): void {
    if (this.open) this.socket?.send(JSON.stringify(message));
  }

  private startBeat(): void {
    this.stopBeat();
    this.beat = setInterval(() => {
      if (!this.open || this.pongBy) return;
      this.socket?.send(PING);
      this.pongBy = setTimeout(() => {
        this.options.log?.("no answer to the heartbeat; redialling");
        this.drop("silent");
        this.later(true);
      }, this.options.pongTimeoutMs ?? 10_000);
    }, this.options.heartbeatMs ?? 20_000);
  }

  private stopBeat(): void {
    if (this.beat) clearInterval(this.beat);
    if (this.pongBy) clearTimeout(this.pongBy);
    this.beat = this.pongBy = undefined;
  }

  /** Detaches and closes the current socket; its late events are ignored. */
  private drop(reason: string): void {
    this.stopBeat();
    const socket = this.socket;
    this.socket = undefined;
    this.open = false;
    if (socket) {
      try {
        socket.close(1000, reason);
      } catch {
        // already gone
      }
    }
  }

  private later(immediate = false): void {
    if (this.closed || this.redial) return;
    const random = (this.options.random ?? Math.random)();
    const ceiling = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempts);
    this.attempts += 1;
    const wait = immediate ? 0 : Math.round(ceiling * (0.5 + random / 2));
    this.redial = setTimeout(() => {
      this.redial = undefined;
      this.connect();
    }, wait);
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
