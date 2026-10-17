import path from "node:path";
import { configureRendering, glyphs, style } from "./transcript";
import { isEssential } from "../ui/navigation";
import { PROVIDER_IDS } from "@archymedes/core/providers/agent-matrix";
import { FREE_GATEWAY_URL } from "@archymedes/core/providers/free-catalog";
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
${style.bold("friday")} — ${t(language, "tagline")}

${style.bold(t(language, "help.startHere"))}
  ${star} friday settings           Paste an API key. Nothing runs until one is saved.
  ${star} friday                    Start a session, then just describe what you want
  ${star} friday --resume           Pick up the last session where it stopped
  ${star} /help                   Inside a session: everything you can do
  ${star} /undo                   Inside a session: take back the last turn's changes
  ${style.dim(t(language, "help.footnote"))}

${style.bold(t(language, "help.running"))}
  friday                      Start an interactive session
  friday "add a health check" Run one request and exit
  friday --plan               Plan mode: read and reason, never write
  friday --auto               Auto mode: ordinary edits apply; sensitive actions ask
  friday --defender           Defender mode: find and fix real security issues, every change still asks
  friday --allow-sensitive    Approve a flagged task preflight (tool guards still apply)
  friday --json "task"        One turn, JSONL on stdout for another program to read
  friday --resume [id]        Continue a previous session ("latest" by default)
  friday --sessions           List sessions in this project
  friday history [search Q]   Browse or search history without starting a model
  friday history status       Check the native index and portable fallback
  friday --cwd <dir>          Work in a different project root
  friday update               Check, confirm, and install the latest Friday CLI
  friday --update             Alias for friday update
  friday update --check       Check for an update without installing it
  friday update --yes         Update without an interactive confirmation
  friday --version            Print the installed CLI version

${style.bold(t(language, "help.files"))}
  friday acp                  Speak the Agent Client Protocol on stdio (for editors)
  friday --sandbox            Work in a remote E2B sandbox, not on this machine
  friday --sandbox docker     Work in a local Docker container instead of a remote one
  friday --docker-image IMG   Image for --sandbox docker (or set DOCKER_CODING_IMAGE)
  friday --sandbox --upload   ...seeded with a copy of this project
  friday --image <preset>     Sandbox image to use (default: general)
  friday --sandbox-minutes N  Sandbox lifetime (default 30)

${style.bold(t(language, "help.model"))}
  friday --free               Free tool models: ${FREE_GATEWAY_URL ? "the hosted free gateway (no key)" : "a free gateway set in ARCHYMEDES_FREE_GATEWAY_URL (no key)"}, or your OPENROUTER_API_KEY
  friday --provider openrouter --model openrouter/auto   Any OpenRouter model on your own key (paid and free)
  friday --provider <name>    ${PROVIDER_IDS.join(" | ")}
  friday --model <id>         Model to run (defaults to the provider's)
  /model                    Pick a model from a list, with prices, keeping the transcript
  /model <name>             Switch straight to one, e.g. /model opus
  /upgrade                  Use your own OpenRouter API key instead of the shared free gateway
  friday --providers          Show which providers are configured, and what is missing
  friday doctor              Test service health, credentials and every endpoint Friday needs
  friday doctor --report     Print a redacted JSON support report with request ids
  friday --doctor             Alias for friday doctor
  friday settings             Configure keys, URLs, models, pricing and voice input

${style.bold(t(language, "help.cost"))}
  friday --location EG        Select a country (auto-detected from your locale by default)
  friday --currency EGP       Select any supported ISO display currency
  friday --budget N           Approve and enforce a cap in the display currency
  friday --slow               Spend at a slower pace: fewer model rounds, smaller replies
  friday --slow strict        Slower still, with a pause between turns
  /slow [on|strict|off]     Change the pace mid-session
  friday --estimate "task"    Show a token/cost forecast without calling the model
  /cost                     Token and cost breakdown for this session

${style.bold(t(language, "help.memory"))}
  # we use bun, not npm     Remember a fact for every future session in this project
  /memory                   Everything remembered, project and personal, with numbers
  /memory add --user <fact> Remember something about you rather than about this project
  /memory forget N          Drop one entry
  /history                  Pick an earlier conversation and continue it
  /resume [<id>|latest]     The same, or straight to one
  /history list             Print past conversations in this project
  /history search <text>    Find one by what you asked for
  /history <id>             Read a past conversation back
  /history delete <id>      Delete a past conversation (--all: every one but this)
  /history status           Show whether native indexed history or JSON fallback is active

${style.bold(t(language, "help.transcript"))}
  /expand [N|all|list]      Unfold written code, a test run, or a long result
  /find <text>              Search this tab's history; /find again for the next match
  /pager                    Open the transcript in $PAGER to search, select or save
  friday --ascii              Draw with plain ASCII when the terminal mangles symbols
  friday --theme chalkboard       Start in a named theme (/theme list shows them all)
  friday --layout scrollback  Plain terminal log instead of the default fixed workspace
  /layout [fixed|scrollback]  Switch layouts mid-session
  PgUp/PgDn, wheel            Scroll the fixed workspace; Alt+Up/Down by line, Ctrl+Home top, Esc live
  friday --pin                Pin the status line to the bottom row. Costs the terminal's
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
