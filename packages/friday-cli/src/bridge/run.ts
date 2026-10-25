import { promises as fs } from "node:fs";
import path from "node:path";
import { AcpHost, type SessionInfo } from "./acp-host";
import { BRIDGE_CONFIG_PATH, parseBridgeConfig, type BridgeConfig } from "./config";
import { runControl } from "./control";
import { Relay, type SocketFactory } from "./relay";

/**
 * `friday bridge`: the process a sandbox runs for its whole life.
 *
 * It is started by the template (so it is already running, snapshotted, when a sandbox is created),
 * waits for the server to write its session config, opens the agent, and then relays between the
 * agent and the session's Durable Object until the server says the session is over.
 *
 * The agent outlives connections: a dropped socket, a pause and a resume change nothing about it.
 * If the agent itself dies it is restarted, and its conversation is loaded again; one that keeps
 * dying (five times in a minute) ends the bridge, since looping on a broken agent only costs money.
 */

export const BRIDGE_VERSION = 1;

/** The bridge's first log line; the sandbox template waits for it before it is snapshotted. */
export const WAITING_LINE = "waiting for a session";

export type BridgeOptions = {
  configPath?: string;
  /** The agent's command line; `friday acp` by default. */
  command?: readonly string[];
  /** Where the agent's session id is kept across its restarts. */
  statePath?: string;
  socket?: SocketFactory;
  /** Environment the agent inherits before the config's own is added. */
  baseEnvironment?: Record<string, string | undefined>;
  pollMs?: number;
  /** How long to wait before restarting a dead agent. */
  restartDelayMs?: number;
  log?: (message: string) => void;
  signal?: AbortSignal;
  /** Test seams. */
  hostFactory?: (options: ConstructorParameters<typeof AcpHost>[0]) => AcpHost;
  heartbeatMs?: number;
  pongTimeoutMs?: number;
};

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;

/** What the agent must never inherit from the bridge's own environment. */
const BRIDGE_ONLY = new Set(["FRIDAY_BRIDGE_CONFIG"]);

type StartResult = "ok" | "failed" | "gave up";

export async function runBridge(options: BridgeOptions = {}): Promise<number> {
  const configPath = options.configPath ?? process.env.FRIDAY_BRIDGE_CONFIG ?? BRIDGE_CONFIG_PATH;
  const log = options.log ?? ((message: string) => process.stderr.write(`[bridge] ${message}\n`));
  const pollMs = options.pollMs ?? 250;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const aborted = () => options.signal?.aborted === true;

  let lastText = "";
  let reported = "";
  /** The config file's current valid contents, or undefined (absent, unchanged-invalid). */
  const readConfig = async (): Promise<{ text: string; config: BridgeConfig } | undefined> => {
    let text: string;
    try {
      text = await fs.readFile(configPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      return { text, config: parseBridgeConfig(text) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== reported) log(message);
      reported = message;
      return undefined;
    }
  };

  // Said once, before waiting: the template's readiness check looks for this line, so the snapshot is
  // only taken once the bridge is really up and watching for its config.
  log(WAITING_LINE);

  // Wait for the server to say who this sandbox is for.
  let current: BridgeConfig | undefined;
  while (!current) {
    if (aborted()) return 0;
    const found = await readConfig();
    if (found) {
      current = found.config;
      lastText = found.text;
    } else {
      await sleep(pollMs);
    }
  }
  log(`session ${current.sessionId}`);

  let info: SessionInfo | undefined;
  let host: AcpHost | undefined;
  let finished: ((code: number) => void) | undefined;
  const done = new Promise<number>((resolve) => { finished = resolve; });
  const starts: number[] = [];
  // Set once the bridge has its answer; a restart waiting on its delay then stays down.
  let over = false;

  const environmentFor = (config: BridgeConfig): Record<string, string | undefined> => {
    const inherited = Object.fromEntries(Object.entries(options.baseEnvironment ?? process.env).filter(([key]) => !BRIDGE_ONLY.has(key)));
    // Nothing here may phone home or replace itself: the sandbox's Friday is the template's, and the
    // person's install count is their own business.
    return { ...inherited, ARCHYMEDES_TELEMETRY: "off", ARCHYMEDES_AUTO_UPDATE: "off", ...config.env };
  };

  const relay = new Relay({
    socket: options.socket ?? ((url, init) => new WebSocket(url, { headers: init.headers } as never) as never),
    hello: () => ({ version: BRIDGE_VERSION, acpSessionId: info?.sessionId, mode: info?.mode, model: info?.model }),
    onFrame: (line) => host?.send(line),
    onControl: (op, args) => runControl(op, args, { cwd: current!.cwd, env: environmentFor(current!) as NodeJS.ProcessEnv }),
    onBye: (reason) => {
      log(`the server ended the session: ${reason}`);
      host?.stop();
      finished?.(0);
    },
    log,
    heartbeatMs: options.heartbeatMs,
    pongTimeoutMs: options.pongTimeoutMs,
  });

  /** Puts the config's files in place under the agent's home, readable by its owner alone: a provider's connection file holds a token. */
  const placeFiles = async (config: BridgeConfig): Promise<void> => {
    const home = config.env.HOME ?? options.baseEnvironment?.HOME ?? process.env.HOME;
    if (!home || config.files.length === 0) return;
    for (const file of config.files) {
      const target = path.resolve(home, file.path);
      // parseBridgeConfig already refused anything but ".config/archymedes/…"; this is the same rule, checked where it is used.
      if (!target.startsWith(path.resolve(home, ".config", "archymedes") + path.sep)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, { mode: 0o600 });
      await fs.chmod(target, 0o600).catch(() => undefined);
    }
  };

  /** Restarts the agent after a death; a restart that dies before it is ready counts as another death. */
  const restart = async (): Promise<void> => {
    for (;;) {
      await sleep(options.restartDelayMs ?? 1_000);
      if (aborted() || over) return;
      const started = await startAgent().catch((): StartResult => "failed");
      if (started === "ok") return;
      if (started === "gave up") return finished?.(1);
    }
  };

  const startAgent = async (): Promise<StartResult> => {
    const now = Date.now();
    starts.push(now);
    while (starts.length > 0 && now - starts[0] > RESTART_WINDOW_MS) starts.shift();
    if (starts.length > MAX_RESTARTS) {
      log(`the agent died ${MAX_RESTARTS} times in a minute; giving up`);
      return "gave up";
    }
    await fs.mkdir(current!.cwd, { recursive: true });
    await placeFiles(current!).catch((error: unknown) => log(`could not place a file: ${error instanceof Error ? error.message : String(error)}`));
    const make = options.hostFactory ?? ((hostOptions) => new AcpHost(hostOptions));
    // An agent that dies before it is ready is its start's to handle (a failed start), not its exit's:
    // otherwise both would restart it, and the exit would clear the host the start is still using.
    let ready = false;
    const started = make({
      command: options.command ?? ["friday", "acp"],
      cwd: current!.cwd,
      env: environmentFor(current!),
      statePath: options.statePath,
      onFrame: (line) => relay.send(line),
      onStderr: (text) => log(`agent: ${text.trimEnd().slice(-500)}`),
      onExit: (code, signal) => {
        if (!ready || host !== started) return;
        log(`the agent exited (${signal ?? code}); restarting`);
        host = undefined;
        void restart();
      },
    });
    host = started;
    try {
      info = await started.start();
    } catch (error) {
      log(`could not start the agent: ${error instanceof Error ? error.message : String(error)}`);
      started.stop();
      if (host === started) host = undefined;
      return "failed";
    }
    ready = true;
    log(`agent ready (${info.sessionId})`);
    // A restarted agent has a new process but, usually, the same session; say hello again either way.
    relay.announce();
    return "ok";
  };

  if ((await startAgent()) !== "ok") return 1;
  relay.setConfig({ url: current.url, secret: current.secret });

  // A new file means a new secret (after a resume) or a new address: reconnect, nothing else changes.
  void (async () => {
    while (!aborted() && !over) {
      await sleep(pollMs);
      const found = await readConfig();
      if (!found || found.text === lastText) continue;
      lastText = found.text;
      current = found.config;
      log("configuration changed; reconnecting");
      relay.setConfig({ url: current.url, secret: current.secret });
    }
  })();

  options.signal?.addEventListener("abort", () => finished?.(0));
  const code = await done;
  over = true;
  relay.close();
  host?.stop();
  return code;
}
