/**
 * The navigation audit: drive every menu in the real CLI, key by key, and have Jev judge each step.
 *
 * Deterministic tests pin what we already know should happen. This finds what we did not think to
 * pin: a key that silently does nothing, a screen with no visible way out, a legend that lies, a
 * frame left half-painted. Each step records the settled screen before and after one keypress (as a
 * terminal emulator renders it, see `VirtualScreen`) together with what that key conventionally
 * does in a list/picker TUI (fzf, editors, every chooser people already know). Jev (TypeSafe System
 * One) then answers four narrow questions per step; code owns the scenarios, the thresholds and what
 * counts as a finding.
 *
 * Run it with `bun run audit:nav` (needs TYPESAFE_API_KEY for the judging pass; without one it still
 * records every transition and checks the mechanical invariants).
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestJevVerdict, type JevQuestion, type JevResponse } from "@archymedes/core/cli/jev";
import { startAnthropicStub, type AnthropicStub } from "./anthropic-stub";
import { spawnArchymedes, type ArchymedesProcess } from "./harness";
import { settle, VirtualScreen } from "./virtual-screen";

export const KEYS = {
  UP: "\x1b[A", DOWN: "\x1b[B", PGUP: "\x1b[5~", PGDN: "\x1b[6~", HOME: "\x1b[H", END: "\x1b[F",
  ESC: "\x1b", ENTER: "\r", BACKSPACE: "\x7f", TAB: "\t",
  CTRL_G: "\x07", CTRL_N: "\x0e", CTRL_P: "\x10", CTRL_U: "\x15",
} as const;

export type NavStep = {
  /** What is sent: a named key or literal text. */
  send: string;
  /** How the key reads in a report: "DOWN", "type 'haiku'". */
  label: string;
  /** What this key conventionally does here, in words a reviewer (and Jev) can check the screen against. */
  expect: string;
};

export type NavScenario = {
  name: string;
  surface: string;
  layout: "fixed" | "scrollback";
  cols: number;
  rows: number;
  steps: NavStep[];
};

const key = (name: keyof typeof KEYS, expect: string): NavStep => ({ send: KEYS[name], label: name, expect });
const type = (text: string, expect: string): NavStep => ({ send: text, label: `type '${text}'`, expect });
const command = (text: string, expect: string): NavStep => ({ send: `${text}\r`, label: `run ${text}`, expect });

/** The scenarios: each starts at an idle prompt and must leave the prompt usable again. */
export function navScenarios(): NavScenario[] {
  const sized = { layout: "fixed" as const, cols: 90, rows: 28 };
  return [
    {
      name: "palette", surface: "command palette (Ctrl+G)", ...sized, steps: [
        key("CTRL_G", "A command palette opens over the session: a filter line, a list of actions with one highlighted, and a key legend."),
        key("DOWN", "The highlight moves down exactly one row; nothing else changes."),
        key("CTRL_P", "Ctrl+P is the Emacs/fzf alias for Up: the highlight moves back up one row."),
        type("mod", "The list narrows as each character is typed to actions matching 'mod' (such as /model), and the filter line shows 'mod'."),
        key("BACKSPACE", "One character is removed from the filter ('mo') and the list widens accordingly."),
        key("ESC", "The first Escape clears the typed filter but keeps the palette open with the full list."),
        key("ESC", "The second Escape closes the palette and returns to the prompt without running anything."),
      ],
    },
    {
      name: "model-picker", surface: "model picker (/model)", ...sized, steps: [
        command("/model", "A model picker opens listing providers' models, with the current model marked and a legend of keys."),
        key("DOWN", "The highlight moves down one row."),
        key("PGDN", "The highlight jumps down by about one visible page, scrolling the list if needed."),
        key("END", "The highlight jumps to the last row of the list."),
        key("HOME", "The highlight jumps back to the first row."),
        type("haiku", "The list narrows to models matching 'haiku' and the filter text is visible."),
        key("ESC", "Escape clears the filter first; the picker stays open showing the full list."),
        key("ESC", "Escape closes the picker without switching models and says nothing changed (or simply returns to the prompt)."),
      ],
    },
    {
      name: "settings", surface: "settings menu (/settings)", ...sized, steps: [
        command("/settings", "The settings menu opens: fields grouped in sections with their current values, one highlighted, and a legend that says Esc saves and leaves."),
        key("DOWN", "The highlight moves to the next field."),
        type("theme", "Typing filters the field list to fields matching 'theme'."),
        key("ENTER", "Enter opens the highlighted field's value list (the themes), showing which value is current."),
        key("DOWN", "The highlight moves to the next theme in the value list."),
        key("ESC", "Escape leaves the value list without changing the setting and returns to the field list."),
        key("ESC", "Escape leaves the settings menu; it says settings were saved and returns to the prompt."),
      ],
    },
    {
      name: "files", surface: "file browser (/files)", ...sized, steps: [
        command("/files", "A file browser opens showing the project tree with one entry highlighted and a key legend."),
        key("DOWN", "The highlight moves to the next file or folder."),
        key("UP", "The highlight moves back up one entry."),
        type("q", "q closes the file browser and returns to the session prompt with nothing typed into it."),
      ],
    },
    {
      name: "help", surface: "help (/help)", ...sized, steps: [
        command("/help", "Help is shown: what the main commands and keys are, in a readable list, ending at a usable prompt or in a view with a visible way out."),
      ],
    },
    {
      name: "history-scroll", surface: "transcript history in the fixed layout", ...sized, steps: [
        command("/help", "Help prints into the transcript, giving it something to scroll back through."),
        key("PGUP", "Page Up scrolls the transcript back by a page; the header indicates the view is in history rather than live."),
        key("ESC", "Escape returns the transcript to the live bottom; the header shows live again."),
      ],
    },
    {
      name: "theme", surface: "theme chooser (/theme)", ...sized, steps: [
        command("/theme", "A theme chooser opens listing themes with the current one marked."),
        key("DOWN", "The highlight moves to the next theme."),
        key("ESC", "Escape closes the chooser, keeps the original theme and says it is unchanged."),
      ],
    },
    {
      name: "settings-filter-legend", surface: "settings menu while a filter is typed", ...sized, steps: [
        command("/settings", "The settings menu opens with a legend naming its keys."),
        type("anthropic", "The field list narrows to Anthropic fields and the legend says Escape now clears the filter."),
        key("ESC", "Escape clears the filter and the full field list returns, with the legend saying Escape saves and leaves."),
        key("ESC", "Escape leaves the settings menu, says settings were saved, and returns to the prompt."),
      ],
    },
    {
      name: "settings-type-ahead", surface: "settings menu, choosing a field and typing its value without pausing", ...sized, steps: [
        command("/settings", "The settings menu opens."),
        { send: "control language\rdeut", label: "type 'control language', Enter, 'deut' in one burst", expect: "The language field opens and its value list is already narrowed to 'deut' (Deutsch): nothing typed in the burst is lost." },
        key("ENTER", "Enter picks Deutsch, confirms it was saved in the menu, and returns to the field list (now possibly in German)."),
        key("ESC", "Escape leaves the settings menu and says settings were saved."),
      ],
    },
    {
      name: "model-picker-narrow", surface: "model picker on a narrow terminal", layout: "fixed", cols: 50, rows: 18, steps: [
        command("/model", "The picker opens and fits the 50-column width: rows are clipped, not wrapped, and the legend is still readable."),
        key("DOWN", "The highlight moves down one row without breaking the layout."),
        key("ESC", "Escape closes the picker cleanly."),
      ],
    },
    {
      name: "palette-scrollback", surface: "command palette in the scrollback layout", layout: "scrollback", cols: 90, rows: 28, steps: [
        key("CTRL_G", "A command palette opens below the prompt with a filter line, a highlighted action and a legend."),
        type("set", "The list narrows to actions matching 'set' (such as /settings)."),
        key("ENTER", "Enter runs the highlighted action; for /settings, the settings menu opens."),
        key("ESC", "Escape leaves the settings menu, saving, and returns to the prompt."),
      ],
    },
  ];
}

/** Jev's questions for one transition. Narrow and independent; code combines them into findings. */
export const NAV_QUESTIONS: Record<string, JevQuestion> = {
  outcome: {
    type: "choice",
    instructions: "A user pressed the key named in `key` while using the terminal interface described by `surface`. `expected` states what that key conventionally does there. Compare `screen_before` with `screen_after`: how well does the change on screen match `expected`?",
    criteria: {
      as_expected: "The screen changed exactly the way `expected` describes, with nothing surprising added.",
      partly: "The screen moved in the expected direction but something is off: the wrong row, leftover or duplicated text, missing feedback, or an extra unintended change.",
      no_visible_effect: "Nothing visible changed, although `expected` requires a visible change.",
      wrong: "The screen did something different from `expected`: closed, opened something else, lost typed input, or ran an action the user did not choose.",
    },
  },
  stuck: {
    type: "noul",
    instructions: "Looking only at `screen_after`, would a first-time user be unsure how to continue or how to leave the current view (no visible legend, prompt or hint, or one that contradicts what is shown)?",
  },
  discoverable: {
    type: "score",
    instructions: "How clearly does `screen_after` show which keys or commands are available right now?",
    criteria: [
      "No visible hint of available keys or commands",
      "A partial or vague hint; important keys such as how to leave are missing",
      "A clear legend or prompt naming the main keys, including how to leave",
    ],
  },
  defect: {
    type: "noul",
    instructions: "Does `screen_after` show a rendering defect: garbled or overlapping text, a menu drawn over unrelated content it should hide, rows cut mid-word without an ellipsis, or fragments left over from a previous frame? Ordinary truncation with an ellipsis is not a defect.",
  },
};

export type NavRecord = {
  scenario: string;
  surface: string;
  layout: string;
  size: string;
  step: number;
  key: string;
  expect: string;
  before: string;
  after: string;
  /** Mechanical checks the code can make without a judge. */
  problems: string[];
  jev?: { outcome: string; outcomeP: Record<string, number>; stuck: number; discoverable: number; defect: number };
};

/** Bounded per screen: Jev reads at most JEV_MAX_STATE_CHARS, and both screens must fit. */
function clipScreen(text: string, max = 1_600): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(screen truncated)`;
}

export function navState(record: Pick<NavRecord, "surface" | "key" | "expect" | "before" | "after" | "size">): string {
  return JSON.stringify({
    surface: `${record.surface}, terminal ${record.size}`,
    key: record.key,
    expected: record.expect,
    screen_before: clipScreen(record.before),
    screen_after: clipScreen(record.after),
  });
}

function judgedFrom(response: JevResponse): NavRecord["jev"] {
  const answers = response.answers;
  const outcome = answers.outcome?.type === "choice" ? answers.outcome : undefined;
  const stuck = answers.stuck?.type === "noul" ? answers.stuck.noul : NaN;
  const defect = answers.defect?.type === "noul" ? answers.defect.noul : NaN;
  const discoverable = answers.discoverable?.type === "score" ? answers.discoverable.score : NaN;
  return { outcome: outcome?.choice ?? "unknown", outcomeP: outcome?.probabilities ?? {}, stuck, discoverable, defect };
}

/** A finding is a step the judge or the mechanical checks say needs a human look. Thresholds live here, in code. */
export function isFinding(record: NavRecord): boolean {
  if (record.problems.length > 0) return true;
  const jev = record.jev;
  if (!jev) return false;
  const bad = (jev.outcomeP.wrong ?? 0) + (jev.outcomeP.no_visible_effect ?? 0);
  return bad >= 0.5 || jev.outcome === "partly" && (jev.outcomeP.partly ?? 0) >= 0.6 || jev.stuck >= 0.6 || jev.defect >= 0.6;
}

async function runScenario(stub: AnthropicStub, scenario: NavScenario, cwd: string): Promise<NavRecord[]> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "archymedes-navaudit-cfg-"));
  const proc: ArchymedesProcess = spawnArchymedes({
    cwd, cols: scenario.cols, rows: scenario.rows,
    args: ["--currency", "USD", ...(scenario.layout === "scrollback" ? ["--layout", "scrollback"] : [])],
    env: {
      ANTHROPIC_API_KEY: "sk-ant-audit", ANTHROPIC_BASE_URL: stub.url, ARCHYMEDES_CONFIG_DIR: configDir,
      ARCHYMEDES_FX_OFFLINE: "true", TZ: "UTC", ARCHYMEDES_NO_MOTION: "1",
      // The session itself must never call Jev: the audit is judged out of band.
      TYPESAFE_API_KEY: undefined,
    },
  });
  const screen = new VirtualScreen(proc, scenario.cols, scenario.rows);
  const records: NavRecord[] = [];
  try {
    await proc.waitFor(/›|auto >/, { timeoutMs: 60_000 });
    let before = await settle(screen);
    for (const [index, step] of scenario.steps.entries()) {
      proc.write(step.send);
      const after = await settle(screen);
      const problems: string[] = [];
      const width = Math.max(...after.split("\n").map((line) => line.length));
      if (width > scenario.cols) problems.push(`a row is ${width} columns wide on a ${scenario.cols}-column terminal`);
      records.push({ scenario: scenario.name, surface: scenario.surface, layout: scenario.layout, size: `${scenario.cols}x${scenario.rows}`,
        step: index + 1, key: step.label, expect: step.expect, before, after, problems });
      before = after;
    }
    // Every scenario must hand back a working prompt: a menu that leaves the keyboard stuck is the
    // worst navigation failure there is, and the one a per-step judgment can miss.
    const mark = proc.output().length;
    proc.write(KEYS.CTRL_U);
    proc.write("/cost\r");
    const healthy = await proc.waitFor(/Session cost/i, { timeoutMs: 10_000, since: mark }).then(() => true, () => false);
    if (!healthy) records[records.length - 1]?.problems.push("the prompt did not run /cost afterwards: the keyboard was left stuck or the menu still open");
  } finally {
    try { proc.kill(); } catch { /* exited */ }
    await rm(configDir, { recursive: true, force: true });
  }
  return records;
}

export async function runNavAudit(options: { apiKey?: string; model?: string; only?: readonly string[] } = {}): Promise<NavRecord[]> {
  const stub = await startAnthropicStub();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "archymedes-navaudit-"));
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "README.md"), "# audit project\n");
  await writeFile(path.join(cwd, "src", "index.ts"), "export const answer = 42;\n");
  const records: NavRecord[] = [];
  try {
    for (const scenario of navScenarios()) {
      if (options.only && !options.only.includes(scenario.name)) continue;
      records.push(...await runScenario(stub, scenario, cwd));
    }
  } finally {
    await stub.close();
    await rm(cwd, { recursive: true, force: true });
  }
  if (options.apiKey) {
    // Independent per step, so they run concurrently, a few at a time to stay polite to the API.
    const pending = [...records];
    const workers = Array.from({ length: 4 }, async () => {
      for (let record = pending.shift(); record; record = pending.shift()) {
        try {
          const response = await requestJevVerdict({ apiKey: options.apiKey!, ...(options.model ? { model: options.model } : {}), state: navState(record), questions: NAV_QUESTIONS });
          record.jev = judgedFrom(response);
        } catch (error) {
          record.problems.push(`judge unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    await Promise.all(workers);
  }
  return records;
}

export function navReport(records: readonly NavRecord[]): string {
  const lines = ["# Navigation audit", ""];
  for (const record of records) {
    const flag = isFinding(record) ? "FLAG" : "ok  ";
    const jev = record.jev
      ? `outcome=${record.jev.outcome} (${Object.entries(record.jev.outcomeP).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}) stuck=${record.jev.stuck.toFixed(2)} keys=${record.jev.discoverable.toFixed(2)}/2 defect=${record.jev.defect.toFixed(2)}`
      : "not judged";
    lines.push(`${flag} ${record.scenario} #${record.step} ${record.key} [${record.layout} ${record.size}] ${jev}${record.problems.length ? ` problems: ${record.problems.join("; ")}` : ""}`);
  }
  return lines.join("\n");
}
