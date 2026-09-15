import path from "node:path";
import { configureRendering, glyphs, style } from "./transcript";
import { isEssential } from "../ui/navigation";
import { PROVIDER_IDS } from "@archymedes/core/providers/agent-matrix";
import { renderCommandHelp } from "../catalog/commands";
import { t, type ControlLanguage } from "../platform/i18n";

/**
 * The `--help` text, built after rendering is configured so its colours match the terminal.
 */

// A function, not a constant: it is built after `configureRendering` has learned whether the
// destination can render colour at all, which a module-level template literal would predate.
export function helpText(language: ControlLanguage = "en", shortcuts: ReadonlyMap<string, string> = new Map()): string {
  // The module-level glyph set, which `configureRendering` has already resolved by the time this
  // is called — the reason this is a function rather than a constant.
  const star = glyphs.star;
  // Marked rather than reordered. This page is grepped and piped as often as it is read, so the
  // rows have to stay where they were; what changes is that a few of them are now findable.
  const mark = (command: string) => (isEssential(command) ? `${star} ` : "  ");
  return `
${style.bold("archymedes")} — ${t(language, "tagline")}

${style.bold(t(language, "help.startHere"))}
  ${star} archymedes settings           Paste an API key. Nothing runs until one is saved.
  ${star} archymedes                    Start a session, then just describe what you want
  ${star} archymedes --resume           Pick up the last session where it stopped
  ${star} /help                   Inside a session: everything you can do
  ${star} /undo                   Inside a session: take back the last turn's changes
  ${style.dim(t(language, "help.footnote"))}

${style.bold(t(language, "help.running"))}
  archymedes                      Start an interactive session
  archymedes "add a health check" Run one request and exit
  archymedes --plan               Plan mode: read and reason, never write
  archymedes --auto               Auto mode: ordinary edits apply; sensitive actions ask
  archymedes --defender           Defender mode: find and fix real security issues, every change still asks
  archymedes --allow-sensitive    Approve a flagged task preflight (tool guards still apply)
  archymedes --json "task"        One turn, JSONL on stdout for another program to read
  archymedes --resume [id]        Continue a previous session ("latest" by default)
  archymedes --sessions           List sessions in this project
  archymedes history [search Q]   Browse or search history without starting a model
  archymedes history status       Check the native index and portable fallback
  archymedes --cwd <dir>          Work in a different project root
  archymedes update               Check, confirm, and install the latest Archymedes CLI
  archymedes --update             Alias for archymedes update
  archymedes update --check       Check for an update without installing it
  archymedes update --yes         Update without an interactive confirmation
  archymedes --version            Print the installed CLI version

${style.bold(t(language, "help.files"))}
  archymedes acp                  Speak the Agent Client Protocol on stdio (for editors)
  archymedes gallery              Draw every UI component once, to see how this terminal renders it
  archymedes gallery all          The same, plus the ASCII, no-colour and narrow fallbacks
  archymedes --sandbox            Work in a remote E2B sandbox, not on this machine
  archymedes --sandbox docker     Work in a local Docker container instead of a remote one
  archymedes --docker-image IMG   Image for --sandbox docker (or set DOCKER_CODING_IMAGE)
  archymedes --sandbox --upload   ...seeded with a copy of this project
  archymedes --image <preset>     Sandbox image to use (default: general)
  archymedes --sandbox-minutes N  Sandbox lifetime (default 30)

${style.bold(t(language, "help.model"))}
  archymedes --free               Free tool models: hosted gateway, or your OPENROUTER_API_KEY
  archymedes --provider <name>    ${PROVIDER_IDS.join(" | ")}
  archymedes --model <id>         Model to run (defaults to the provider's)
  /model                    Pick a model from a list, with prices, keeping the transcript
  /model <name>             Switch straight to one, e.g. /model opus
  archymedes --providers          Show which providers are configured, and what is missing
  archymedes doctor              Test service health, credentials and every endpoint Archymedes needs
  archymedes doctor --report     Print a redacted JSON support report with request ids
  archymedes --doctor             Alias for archymedes doctor
  archymedes settings             Configure keys, URLs, models, pricing and voice input

${style.bold(t(language, "help.cost"))}
  archymedes --location EG        Select a country (auto-detected from your locale by default)
  archymedes --currency EGP       Select any supported ISO display currency
  archymedes --budget N           Approve and enforce a cap in the display currency
  archymedes --slow               Spend at a slower pace: fewer model rounds, smaller replies
  archymedes --slow strict        Slower still, with a pause between turns
  /slow [on|strict|off]     Change the pace mid-session
  archymedes --estimate "task"    Show a token/cost forecast without calling the model
  /cost                     Token and cost breakdown for this session

${style.bold(t(language, "help.memory"))}
  # we use bun, not npm     Remember a fact for every future session in this project
  /memory                   Everything remembered, project and personal, with numbers
  /memory add --user <fact> Remember something about you rather than about this project
  /memory forget N          Drop one entry
  /history                  Past conversations in this project
  /history search <text>    Find one by what you asked for
  /history <id>             Read a past conversation back
  /history resume           Pick one up where it stopped
  /history status           Show whether native indexed history or JSON fallback is active

${style.bold(t(language, "help.transcript"))}
  /expand [N|all|list]      Unfold written code, a test run, or a long result
  /find <text>              Search this tab's history; /find again for the next match
  /pager                    Open the transcript in $PAGER to search, select or save
  archymedes --ascii              Draw with plain ASCII when the terminal mangles symbols
  archymedes --theme chalkboard       Start in a named theme (/theme list shows them all)
  archymedes --layout scrollback  Plain terminal log instead of the default fixed workspace
  /layout [fixed|scrollback]  Switch layouts mid-session
  PgUp/PgDn, wheel            Scroll the fixed workspace; Alt+Up/Down by line, Ctrl+Home top, Esc live
  archymedes --pin                Pin the status line to the bottom row. Costs the terminal's
                            scrollback: a reserved footer means scrolled-off lines are
                            never saved, so this is off unless you ask for it.
                            (or set ARCHYMEDES_GLYPHS=ascii)

${style.bold(t(language, "help.headless"))}
  With --json, stdout carries one JSON object per line and nothing else; everything
  a person would read goes to stderr. Exit codes are stable:
    0 completed   1 failed    2 usage         3 blocked
    4 unverified  5 approval  6 limit hit     7 cancelled

${style.bold(t(language, "help.inSession"))}  ${style.dim(`(${star} ${t(language, "help.sessionHint")})`)}
${renderCommandHelp(language, shortcuts, { mark })}
`;
}
