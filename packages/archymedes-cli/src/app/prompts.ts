import { type Interface } from "node:readline/promises";
import path from "node:path";
import { FOLD_AFTER_LINES, activity, endStreamedLine, glyphs, markdown, out, renderEvent, screen, sectionStyle, spinner, statusBar, style } from "./transcript";
import { type DaemonApprovalRequest } from "@archymedes/core/cli/daemon";
import type { PermissionDecision } from "@archymedes/core/cli/permissions";
import { type SafetyAssessment } from "@archymedes/core/cli/safety";
import { openChooser } from "../ui/shortcuts";
import { type SettingsPrompts } from "../platform/settings";
import { renderFileChange } from "../render/code-view";

/**
 * Questions the terminal session asks the person: tool approvals, sensitive-task and spending-cap
 * confirmations, hidden input, and the settings chooser.
 */

/**
 * Everything that can occupy the last rows of the screen, and therefore has to be closed or
 * cleared before anything else prints there.
 *
 * `markdown` holds a partial assistant line, `toolLine` holds a tool call awaiting its result,
 * and `statusBar` holds the spinner. They are module state for the same reason `renderEvent` is a
 * module function: the renderer is one thing with one screen, and threading three cursors through
 * every call site is how the two of them fall out of step.
 *
 * `screen` is undefined outside a real interactive TTY session — a one-shot `archymedes "..."` run, a
 * pipe, `--estimate` — every one of which prints a few lines and exits, where a pinned footer would
 * be pure overhead with nothing to keep separately scrolled from. `statusBar`'s own erase-above-
 * cursor redraw stays the fallback for exactly that case; `screen`, when present, takes over
 * instead — `statusBar.clear()`'s calls elsewhere stay in place and are simply harmless no-ops once
 * nothing is ever drawn through it.
 */
/**
 * readline runtime state that `@types/node` leaves untyped. The current line, its input stream,
 * and the closed flag all exist on the interface at runtime (readline is written in plain JS).
 */
export type ReadlineInternals = {
  input: NodeJS.ReadableStream;
  closed: boolean;
  line: string;
};

/**
 * Exchange rates, from configuration only.
 *
 * Deliberately not fetched: a CLI that silently calls a rates API turns every cost display into a
 * network dependency, and a stale-but-known rate is more auditable than a fresh-but-invisible one.
 * `ARCHYMEDES_FX_FROM=USD ARCHYMEDES_FX_TO=EUR ARCHYMEDES_FX_RATE=0.92` is the whole interface, and the rate's date is recorded beside it so
 * a historical figure can be reconciled later.
 */
/**
 * Builds the `choose` half of `SettingsPrompts` from a readline.
 *
 * Defined once and used by all three ways into settings — first run, `archymedes settings`, `/settings` —
 * because a menu that navigates differently depending on how you opened it is the specific thing
 * this is meant to stop.
 */
export function settingsChooser(readline: Interface): NonNullable<SettingsPrompts["choose"]> {
  return (request) => openChooser(
    { readline, input: process.stdin, output: process.stdout },
    request.items.map((item) => ({ ...item })),
    {
      title: request.title,
      ...(request.filter ? { filter: true } : {}),
      ...(request.initialIndex === undefined ? {} : { initialIndex: request.initialIndex }),
      height: 12,
      // The real terminal, so rows are clipped rather than wrapped onto lines the repaint does
      // not know it drew.
      width: process.stdout.columns ?? 80,
      glyphs,
      paint: { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow },
    },
  );
}

/**
 * The approval gate, as a person experiences it.
 *
 * `signal` reaches in for the *current turn's* abort signal at ask-time, not construction-time:
 * one prompt function is built per agent and lives across many turns, while an `AbortSignal` is
 * single-use. Ctrl+C during a normal tool loop cancels via `agent.cancel()`, a flag the runtime
 * only checks between steps — but a pending `readline.question()` here is not a step the runtime
 * is looping over, so that flag alone leaves it blocked forever on an answer nobody can give
 * anymore. Aborting the question is what actually returns control to the prompt.
 */
/** What a pending `write_file`/`edit_file` approval would actually change — no file read needed: `write_file` carries its whole new content, `edit_file` carries the exact before/after snippet. */
export function renderApprovalPreview(preview: DaemonApprovalRequest["preview"]): string | undefined {
  if (!preview) return undefined;
  const rendered = preview.toolName === "write_file"
    ? renderFileChange({ path: preview.path, kind: "write", content: preview.content }, sectionStyle(), { maxLines: FOLD_AFTER_LINES })
    : renderFileChange({ path: preview.path, kind: "edit", before: preview.oldText, after: preview.newText }, sectionStyle(), { maxLines: FOLD_AFTER_LINES });
  return rendered.text;
}

export function createApprovalPrompt(readline: Interface, interactive: boolean, signal: () => AbortSignal | undefined) {
  return async ({ summary, safety, preview }: { summary: string; safety?: SafetyAssessment; preview?: DaemonApprovalRequest["preview"] }): Promise<PermissionDecision> => {
    // Without a terminal there is nobody to ask, and a prompt written to a pipe would either hang
    // or read the next line of piped input as an answer. Denying is the only honest result — and
    // it is reported, so the run does not look like the model simply chose not to act.
    if (!interactive) {
      out.write(`\n  ${style.yellow("!")} Archymedes needs approval to ${style.bold(summary)}, but stdin is not a terminal.\n`);
      out.write(`    ${style.dim("Re-run with --auto to pre-approve workspace edits.")}\n`);
      return "deny_always";
    }
    // A tool call can arrive before the model emits visible text. In that case the TUI spinner is
    // still redrawing the last row and can overwrite the first approval question unless it is
    // explicitly stopped here.
    activity.awaitingFirstDelta = false;
    spinner?.stop();
    statusBar.clear();
    endStreamedLine();
    out.write(`\n  ${style.yellow("?")} Archymedes wants to ${style.bold(summary)}\n`);
    // What you approve is what gets executed — see the exact change before answering, not just
    // the one-line summary. Reuses the same renderer the post-write receipt already shows, built
    // straight from the call's own arguments, so nothing here can differ from what actually runs.
    const previewText = renderApprovalPreview(preview);
    if (previewText) out.write(`${previewText}\n`);
    if (safety?.sensitive) out.write(`    ${style.yellow("Safety guard:")} ${safety.reasons.join(", ")}\n`);
    let answer: string;
    try {
      answer = (await readline.question(`    ${style.dim("[y]es / [n]o / [a]lways / [d]eny always: ")}`, { signal: signal() })).trim().toLowerCase();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        out.write(style.yellow("\n  interrupted — treating as denied\n"));
        return "deny";
      }
      throw error;
    }
    if (answer === "a" || answer === "always") return "allow_always";
    if (answer === "d") return "deny_always";
    if (answer === "n" || answer === "no") return "deny";
    return answer === "" || answer === "y" || answer === "yes" ? "allow" : "deny";
  };
}

/** Sensitive objectives are acknowledged before estimation, model contact, or sandbox effects. */
export async function confirmSensitiveTask(
  readline: Interface,
  interactive: boolean,
  assessment: SafetyAssessment,
  explicitlyAllowed = false,
): Promise<boolean> {
  if (!assessment.sensitive) return true;
  const detail = assessment.reasons.join(", ");
  if (explicitlyAllowed) {
    out.write(`  ${style.yellow("Safety guard:")} ${detail} — task preflight approved by --allow-sensitive.\n`);
    return true;
  }
  if (!interactive) {
    out.write(`  ${style.yellow("Safety guard blocked this task:")} ${detail}.\n`);
    out.write(`    ${style.dim("Review it, then re-run with --allow-sensitive. Sensitive tool operations remain separately gated.")}\n`);
    return false;
  }
  statusBar.clear();
  const answer = (await readline.question(`  ${style.yellow("Safety review:")} ${style.bold(detail)}. Continue? ${style.dim("[y/N]: ")}`)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** Confirms the one bounded amount the session may spend before any sandbox or model is started. */
export async function confirmSpendingCap(readline: Interface, interactive: boolean, renderedCap: string): Promise<boolean> {
  // A non-interactive caller supplied --budget in the command itself; that explicit argument is
  // the approval. Prompting a pipe would hang or consume the task text as an answer.
  if (!interactive) return true;
  statusBar.clear();
  const answer = (await readline.question(`  ${style.yellow("?")} Approve a session spend cap of ${style.bold(renderedCap)}? ${style.dim("[Y/n]: ")}`)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

/** Ctrl+D/EOF is a normal way to leave a terminal program, never an application failure. */
export function isReadlineExit(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted with ctrl\+d|readline was closed/i.test(error.message));
}

/** Reads a secret through readline without echoing pasted credentials to the terminal or history. */
export async function hiddenQuestion(readline: Interface, question: string): Promise<string> {
  process.stdout.write(`${question}${style.dim("[input hidden] ")}`);
  const stdout = process.stdout as typeof process.stdout & { write: typeof process.stdout.write };
  const original = stdout.write;
  try {
    stdout.write = (() => true) as typeof process.stdout.write;
    const answer = await readline.question("");
    // readline records answers automatically. A hidden value must not become visible again when
    // the user presses Up, nor reach the persistent prompt history file.
    const history = (readline as Interface & { history?: string[] }).history;
    if (history) {
      for (let index = history.length - 1; index >= 0; index -= 1) if (history[index] === answer) history.splice(index, 1);
    }
    return answer;
  } finally {
    stdout.write = original;
    original.call(process.stdout, "\n");
  }
}
