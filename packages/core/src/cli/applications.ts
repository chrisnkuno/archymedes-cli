/**
 * Lifecycle management for local development servers Archymedes starts on a user's behalf.
 * A preview is reported only after HTTP readiness, remains alive across turns, and is torn down
 * with the workspace so a completed CLI session cannot leak background process trees.
 *
 * A process with no port (a worker, a bot, a watcher, a queue consumer) is a background process:
 * started once it is still running after a short settle, with the same logs, status and stop.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { sanitizeCommandEnvironment } from "./command";

const MAX_LOG_BYTES = 128 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
/** How long a background process must stay up to count as started: most crashes on start come sooner. */
const DEFAULT_SETTLE_MS = 3_000;

export type ApplicationStatus = {
  id: string;
  command: string;
  directory: string;
  /** Absent for a background process, which serves nothing to check. */
  port?: number;
  url?: string;
  state: "starting" | "running" | "exited";
  startedAt: number;
  exitCode?: number;
  stdout: string;
  stderr: string;
};

export type StartApplicationRequest = {
  command: string;
  /** Omitted: a background process, started once it survives the settle time (`timeoutMs`). */
  port?: number;
  directory?: string;
  path?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type ApplicationProcess = ChildProcessByStdio<null, Readable, Readable>;
type ManagedApplication = ApplicationStatus & { process: ApplicationProcess };

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return Buffer.byteLength(next) <= MAX_LOG_BYTES
    ? next
    : Buffer.from(next).subarray(Buffer.byteLength(next) - MAX_LOG_BYTES).toString("utf8");
}

function terminateProcessTree(child: ApplicationProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // The process may have exited between the status check and the signal.
  }
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function httpIsReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 750 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.once("timeout", () => { request.destroy(); resolve(false); });
    request.once("error", () => resolve(false));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keeps user-requested local preview servers alive across model turns. */
export class LocalApplicationSupervisor {
  private readonly applications = new Map<string, ManagedApplication>();
  private nextId = 1;

  constructor(private readonly root: string) {}

  async start(request: StartApplicationRequest): Promise<ApplicationStatus> {
    if (!request.command.trim()) throw new Error("command must be a non-empty string");
    const port = request.port;
    if (port !== undefined) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("port must be an integer between 1 and 65535");
      if (this.list().some((application) => application.state !== "exited" && application.port === port)) {
        throw new Error(`Friday already has an application on port ${port}. Stop it before starting another one.`);
      }
      if (await portIsOpen(port)) throw new Error(`Port ${port} is already in use by another process.`);
    }

    const relativeDirectory = request.directory?.trim() || ".";
    const directory = path.resolve(this.root, relativeDirectory);
    const relative = path.relative(path.resolve(this.root), directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("directory must stay inside the project workspace");
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`Application directory does not exist: ${relativeDirectory}`);

    const route = request.path?.trim() || "/";
    if (!route.startsWith("/") || route.startsWith("//")) throw new Error("path must begin with one slash");
    const url = port === undefined ? undefined : `http://127.0.0.1:${port}${route}`;
    const id = `app-${this.nextId++}`;
    const child = spawn(request.command, [], {
      cwd: directory,
      shell: true,
      detached: process.platform !== "win32",
      env: sanitizeCommandEnvironment(process.env) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const application: ManagedApplication = {
      id,
      command: request.command,
      directory: relativeDirectory,
      ...(port === undefined ? {} : { port, url }),
      state: "starting",
      startedAt: Date.now(),
      stdout: "",
      stderr: "",
      process: child,
    };
    this.applications.set(id, application);
    child.stdout.on("data", (chunk) => { application.stdout = appendBounded(application.stdout, chunk); });
    child.stderr.on("data", (chunk) => { application.stderr = appendBounded(application.stderr, chunk); });
    child.once("error", (error) => {
      application.stderr = appendBounded(application.stderr, error.message);
      application.state = "exited";
      application.exitCode = 127;
    });
    child.once("close", (code) => {
      application.state = "exited";
      application.exitCode = code ?? application.exitCode ?? 1;
    });

    if (url === undefined) return this.settle(application, directory, Math.min(Math.max(request.timeoutMs ?? DEFAULT_SETTLE_MS, 500), 60_000), request.signal);

    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 1_000), 60_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (request.signal?.aborted) {
        await this.stop(id);
        throw new Error("Application start was cancelled.");
      }
      if (application.state === "exited") throw new Error(await this.exitedMessage(application, directory));
      if (await httpIsReady(url)) {
        application.state = "running";
        return this.snapshot(application);
      }
      await wait(150);
    }

    // A crash that lands during the last poll is still a crash, not a slow start.
    if (application.state === "exited") throw new Error(await this.exitedMessage(application, directory));
    await this.stop(id);
    throw new Error(this.failureMessage(application, `Application did not answer HTTP at ${url} within ${timeoutMs}ms and was stopped.`));
  }

  /** A background process is started when it is still running once `settleMs` has passed. */
  private async settle(application: ManagedApplication, directory: string, settleMs: number, signal?: AbortSignal): Promise<ApplicationStatus> {
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.stop(application.id);
        throw new Error("Application start was cancelled.");
      }
      if (application.state === "exited") break;
      await wait(100);
    }
    if (application.state === "exited") throw new Error(await this.exitedMessage(application, directory));
    application.state = "running";
    return this.snapshot(application);
  }

  list(): ApplicationStatus[] {
    return [...this.applications.values()].map((application) => this.snapshot(application));
  }

  get(id?: string): ApplicationStatus[] {
    if (!id) return this.list();
    const application = this.applications.get(id);
    return application ? [this.snapshot(application)] : [];
  }

  async stop(id: string): Promise<ApplicationStatus> {
    const application = this.applications.get(id);
    if (!application) {
      const known = [...this.applications.keys()];
      throw new Error(`Unknown application: ${id}. ${known.length > 0 ? `Running or known: ${known.join(", ")}.` : "No applications are managed right now; start one with start_application."}`);
    }
    if (application.state !== "exited") {
      terminateProcessTree(application.process);
      await Promise.race([
        new Promise<void>((resolve) => application.process.once("close", () => resolve())),
        wait(1_000).then(() => {
          if (application.state !== "exited" && application.process.pid && process.platform !== "win32") {
            try { process.kill(-application.process.pid, "SIGKILL"); } catch {
              // It exited after the state check; the desired stopped state is already true.
            }
          }
        }),
      ]);
      application.state = "exited";
    }
    return this.snapshot(application);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.applications.values()].filter((application) => application.state !== "exited").map((application) => this.stop(application.id)));
  }

  private snapshot(application: ManagedApplication): ApplicationStatus {
    const { process: _process, ...status } = application;
    return { ...status };
  }

  private async exitedMessage(application: ManagedApplication, directory: string): Promise<string> {
    const code = application.exitCode === undefined ? "" : ` with exit code ${application.exitCode}`;
    const before = application.port === undefined ? "within its first moments" : `before port ${application.port} became ready`;
    return this.failureMessage(application, `Application exited${code} ${before}.${await this.exitHint(application, directory)}`);
  }

  /**
   * Why a process that exited was the wrong thing to start, when that is knowable. The common miss is
   * a browser app (canvas game, p5, plain HTML) started as `node game.js`: Node has no window, so it
   * crashes, and the model retries variations of the same command. An index.html says "serve this".
   */
  private async exitHint(application: ManagedApplication, directory: string): Promise<string> {
    const hints: string[] = [];
    if (application.exitCode === 0) {
      hints.push(application.port === undefined
        ? "The command finished instead of staying up: it is a one-shot command, so run it with run_command."
        : `The command finished instead of staying up; start_application needs a process that keeps running and listens on port ${application.port}.`);
    }
    const hasPage = await stat(path.join(directory, "index.html")).then((info) => info.isFile(), () => false);
    if (hasPage && application.port !== undefined && !/\b(serve|http-server|http\.server|live-server|vite|webpack|next|parcel)\b/.test(application.command)) {
      hints.push(`${application.directory === "." ? "The project" : application.directory} has an index.html: if this is a browser app, serve the folder instead of running its script under Node, e.g. \`npx --yes http-server -p ${application.port} -c-1 .\` or \`python3 -m http.server ${application.port}\`.`);
    }
    return hints.length > 0 ? ` ${hints.join(" ")}` : "";
  }

  private failureMessage(application: ManagedApplication, message: string): string {
    const logs = [application.stdout.trim(), application.stderr.trim()].filter(Boolean).join("\n");
    return logs ? `${message}\n\nRecent logs:\n${logs}` : `${message}\n\nThe process produced no logs.`;
  }
}
