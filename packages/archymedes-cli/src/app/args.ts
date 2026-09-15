import path from "node:path";
import type { ArchymedesMode } from "@archymedes/core/cli/permissions";
import { isCurrency, type Currency } from "@archymedes/core/money";
import { parseHistoryCommand, type HistoryCommand } from "../commands/chat-history";
import { parsePaceFlag, type PaceLevel } from "../commands/pacing";
import type { SandboxBackend } from "../session/location";

export type ParsedArgs = {
  mode: ArchymedesMode;
  /** Whether a command-line mode flag should override a resumed session's saved posture. */
  modeExplicit: boolean;
  /** Speak the Agent Client Protocol on stdio instead of running a terminal session. */
  acp: boolean;
  /** Draw every UI component once and exit, for looking at rendering rather than behaviour. */
  gallery: boolean;
  prompt: string | null;
  resume: string | null;
  historyCommand: HistoryCommand | null;
  listSessions: boolean;
  listProviders: boolean;
  doctor: boolean;
  doctorReport: boolean;
  update: boolean;
  checkUpdate: boolean;
  settings: boolean;
  estimateOnly: boolean;
  updateYes: boolean;
  packageManager: string | undefined;
  version: boolean;
  root: string;
  help: boolean;
  /**
   * Where files are written: this machine, a throwaway remote E2B sandbox, or a local Docker
   * container — the last being the option for keeping work off the working tree without sending it
   * to a third party, which is the only isolation some environments will accept.
   */
  backend: SandboxBackend;
  /** Image for `--sandbox docker`. Overridable because no single image suits every project's toolchain. */
  dockerImage: string;
  /** Seed the sandbox with the local project instead of starting empty. */
  upload: boolean;
  /** Sandbox image to start, by workspace preset id. */
  preset: string | undefined;
  sandboxMinutes: number;
  /** Session ceiling in the display currency; the agent stops rather than spending past it. */
  budget: number | undefined;
  provider: string | undefined;
  model: string | undefined;
  currency: Currency | undefined;
  country: string | undefined;
  language: string | undefined;
  /** Explicit task-level consent for non-interactive sensitive work; tool gates still apply. */
  allowSensitive: boolean;
  /**
   * How fast the agent is allowed to spend.
   *
   * A pace, not a cap — `--budget` is the cap. This bounds how much work one turn may do before it
   * has to come back and report, which is the difference between a surprise and a decision.
   */
  pace: PaceLevel;
  /**
   * Force the ASCII glyph set regardless of what the environment claims.
   *
   * The detection in `glyphs.ts` is a heuristic over `LANG` and `TERM`, and a heuristic that gets it
   * wrong leaves someone reading `?` where a status mark should be. This is the escape hatch, and it
   * is a flag rather than only an environment variable because the person who needs it is looking at
   * broken output right now.
   */
  ascii: boolean;
  /** Theme name from `--theme`; absent means the terminal's own preference decides. */
  theme: string | undefined;
  /**
   * Pin the status footer to the bottom of the window.
   *
   * Off by default, and that default is a bug fix rather than a preference. The footer is held there
   * with `DECSTBM`, and a terminal only pushes lines into its scrollback when the scrolling region
   * is the *whole* screen — so reserving two rows for a footer silently cost the session every line
   * that scrolled past the top. Nothing could be scrolled back to, which is precisely what people
   * reported. The footer is worth having, but not at that price, so it is now something you ask for.
   */
  pin: boolean;
  /** `--layout`; unset means `resolveLayout` decides (the fixed workspace for an interactive terminal). */
  layout?: "fixed" | "scrollback";
  /**
   * Machine-readable output: JSONL on stdout, human text on stderr, a stable exit code.
   *
   * Implies a single turn. A REPL that emits JSONL has nobody to read it, and the approval prompt
   * it would need is exactly what headless callers cannot answer.
   */
  json: boolean;
};

/** Shape of the ids `newSessionId` mints, e.g. `20260808T001720Z-2ubjpz`. */
const SESSION_ID = /^\d{8}T\d{6}Z-[a-z0-9]{6}$/;

/**
 * Image for `--sandbox docker` when neither `--docker-image` nor `DOCKER_CODING_IMAGE` says
 * otherwise. A plain Debian-slim base rather than a Archymedes-specific image: it exists on every Docker
 * install's reach, and a default that silently fails to pull is worse than a plain one that works.
 */
const DEFAULT_DOCKER_IMAGE = "debian:stable-slim";

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const acpRequested = argv[0] === "acp" || argv.includes("--acp");
  const updateRequested = argv[0] === "update" || argv.includes("--update") || argv.includes("--check-update");
  const settingsRequested = argv[0] === "settings" || argv.includes("--settings");
  const historyRequested = argv[0] === "history";
  const doctorRequested = argv[0] === "doctor" || argv.includes("--doctor");
  const parsed: ParsedArgs = {
    mode: "build", modeExplicit: false, prompt: null, resume: null, historyCommand: null, listSessions: false, listProviders: false, doctor: doctorRequested, doctorReport: false,
    update: updateRequested, checkUpdate: false, updateYes: false, packageManager: undefined, version: false, settings: settingsRequested, estimateOnly: false,
    root: process.cwd(), help: false, pace: "off", ascii: false, theme: undefined, pin: false,
    acp: acpRequested,
    gallery: argv[0] === "gallery" || argv.includes("--gallery"),
    backend: "local", dockerImage: DEFAULT_DOCKER_IMAGE, upload: false, preset: undefined, sandboxMinutes: 30, budget: undefined, provider: undefined, model: undefined, currency: undefined, country: undefined, language: undefined, allowSensitive: false, json: false,
  };
  const rest: string[] = [];
  let freeRequested = false;
  let otherProviderRequested = false;

  for (let index = argv[0] === "update" || argv[0] === "settings" || argv[0] === "acp" || argv[0] === "gallery" || argv[0] === "doctor" || historyRequested ? 1 : 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan" || argument === "-p") { parsed.mode = "plan"; parsed.modeExplicit = true; }
    else if (argument === "--auto" || argument === "-y") { parsed.mode = "auto"; parsed.modeExplicit = true; }
    else if (argument === "--build") { parsed.mode = "build"; parsed.modeExplicit = true; }
    else if (argument === "--defender") { parsed.mode = "defender"; parsed.modeExplicit = true; }
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--free") { freeRequested = true; parsed.provider = "free"; }
    else if (argument === "--version" || argument === "-v") parsed.version = true;
    else if (argument === "--settings") parsed.settings = true;
    else if (argument === "--acp") parsed.acp = true;
    else if (argument === "--gallery") parsed.gallery = true;
    else if (argument === "--estimate") parsed.estimateOnly = true;
    else if (argument === "--allow-sensitive") parsed.allowSensitive = true;
    else if (argument === "--json" || argument === "--headless") parsed.json = true;
    else if (argument === "--ascii" || argument === "--no-unicode") parsed.ascii = true;
    else if (argument === "--pin") parsed.pin = true;
    else if (argument === "--no-pin") parsed.pin = false;
    else if (argument === "--layout") {
      const value = argv[++index];
      if (value !== "fixed" && value !== "scrollback") throw new Error("--layout expects fixed or scrollback");
      parsed.layout = value;
    }
    else if (argument === "--theme") {
      // A bare --theme takes the next word only when it looks like a theme name rather than the
      // start of the request, the same rule --sandbox and --slow already follow.
      const next = argv[index + 1];
      if (next && !next.startsWith("-") && /^[A-Za-z0-9_-]+$/.test(next)) { parsed.theme = next; index += 1; }
    }
    else if (argument === "--slow" || argument === "--pace") {
      // `--slow` on its own means the obvious thing; a value selects how slow.
      const level = parsePaceFlag(argv[index + 1]);
      if (level) { parsed.pace = level; index += 1; } else parsed.pace = "gentle";
    }
    else if (argument === "--update") parsed.update = true;
    else if (argument === "--check-update") { parsed.update = true; parsed.checkUpdate = true; }
    else if (argument === "--check" && updateRequested) parsed.checkUpdate = true;
    else if (argument === "--yes" && updateRequested) parsed.updateYes = true;
    else if (argument === "--package-manager" && updateRequested) { parsed.packageManager = argv[index + 1]; index += 1; }
    else if (argument === "--sessions") parsed.listSessions = true;
    else if (argument === "--providers") parsed.listProviders = true;
    else if (argument === "--doctor") parsed.doctor = true;
    else if (argument === "--report" && doctorRequested) parsed.doctorReport = true;
    else if (argument === "--resume") {
      // Only swallow the next word when it is actually a session id. Otherwise `archymedes --resume "fix
      // the test"` silently treats the request as an id, resumes nothing, and drops into the REPL.
      const next = argv[index + 1];
      if (next && (next === "latest" || SESSION_ID.test(next))) { parsed.resume = next; index += 1; }
      else parsed.resume = "latest";
    }
    else if (argument === "--cwd") { parsed.root = path.resolve(argv[index + 1] ?? "."); index += 1; }
    else if (argument === "--sandbox") {
      const value = argv[index + 1];
      // `--sandbox` on its own means the obvious thing; a value selects explicitly.
      if (value === "local" || value === "e2b" || value === "docker") { parsed.backend = value; index += 1; } else parsed.backend = "e2b";
    }
    else if (argument === "--upload") parsed.upload = true;
    else if (argument === "--image") { parsed.preset = argv[index + 1]; index += 1; }
    else if (argument === "--sandbox-minutes") { parsed.sandboxMinutes = Number(argv[index + 1] ?? 30); index += 1; }
    else if (argument === "--docker-image") { parsed.dockerImage = argv[index + 1] ?? DEFAULT_DOCKER_IMAGE; index += 1; }
    else if (argument === "--budget" || argument === "--max-rwf") { parsed.budget = Number(argv[index + 1] ?? 0) || undefined; index += 1; }
    else if (argument === "--provider") {
      parsed.provider = argv[++index];
      if (parsed.provider === "free") freeRequested = true;
      else otherProviderRequested = true;
    }
    else if (argument === "--model") { parsed.model = argv[index + 1]; index += 1; }
    else if (argument === "--currency") {
      const value = (argv[index + 1] ?? "").toUpperCase();
      if (isCurrency(value)) parsed.currency = value;
      index += 1;
    }
    else if (argument === "--location" || argument === "--country") { parsed.country = argv[index + 1]?.toUpperCase(); index += 1; }
    else if (argument === "--language" || argument === "--lang") { parsed.language = argv[index + 1]; index += 1; }
    else rest.push(argument);
  }
  if (freeRequested && otherProviderRequested) throw new Error("--free/--provider free cannot be combined with another --provider.");
  if (freeRequested) parsed.provider = "free";
  if (historyRequested) parsed.historyCommand = parseHistoryCommand(`/history ${rest.join(" ")}`);
  else if (rest.length > 0) parsed.prompt = rest.join(" ");
  return parsed;
}
