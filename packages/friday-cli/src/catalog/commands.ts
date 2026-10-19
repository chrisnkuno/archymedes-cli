import { commandDescription, keyboardDescription, type ControlLanguage } from "../platform/i18n";

/**
 * The slash-command registry.
 *
 * A table rather than an `if` chain for two reasons: `/help` is generated from it, so the two
 * cannot drift apart the way a hand-maintained help string can; and `node:readline`'s `completer`
 * option can walk it directly, which is what gives Tab-completion on "/" for free.
 */

export type Command = {
  name: string;
  /** Shown after the name in `/help`, e.g. "[dir]" for `/pull [dir]`. Omit for no-argument commands. */
  args?: string;
  description: string;
};

export function defineCommands<T extends Record<string, Omit<Command, "name">>>(table: T): (Command & { name: keyof T & string })[] {
  return Object.entries(table).map(([name, command]) => ({ name, ...command }));
}

export const COMMANDS = defineCommands({
  "/layout": { args: "[fixed|scrollback]", description: "Toggle the fixed workspace or terminal scrollback layout" },
  "/mode": { args: "[plan|build|auto|defender]", description: "Show or switch the permission mode" },
  "/plan": { description: "Switch to plan mode — read and reason, no writes" },
  "/build": { description: "Switch to build mode — edits need approval" },
  "/auto": { description: "Auto-apply ordinary edits; sensitive actions still ask" },
  "/defender": { description: "Switch to defender mode — find and fix real security issues, every change still asks" },
  "/models": { args: "[refresh]", description: "Every model each provider actually offers, with prices — or add a key for one you can't use yet" },
  "/model": { args: "[name | N | provider model]", description: "Open the model picker, or switch straight to a name, keeping the transcript" },
  "/fallback": { args: "[off|ask|provider:model]", description: "Opt into a safe alternate model after transient provider failures" },
  "/undo": { args: "[code|conversation]", description: "Revert the last turn — files, the conversation, or both (default)" },
  "/retry": { description: "Repeat the last failed request only when no tool or file change already happened" },
  "/continue": { description: "Resume an interrupted or incomplete task from its current workspace state" },
  "/diff": { description: "What changed since the last checkpoint" },
  "/todos": { description: "The agent's current plan" },
  "/task": { description: "Where the whole task stands: request, plan, changes, verification, blockers" },
  "/route": { args: "[all|summary|plan]", description: "The hosted exchange's routing decision: chosen model, alternatives, policy, est vs actual cost. `plan` forecasts the next turn before spending" },
  "/clear": { description: "Start a fresh thread" },
  "/memory": { args: "[add|replace|recall|forget]", description: "Bounded, relevant memory across sessions — # <fact> remembers for this project" },
  "/history": { args: "[list | <id> | search <text> | delete <id>|--all | status]", description: "Go back to an earlier conversation — opens a picker (Del deletes one); list prints them, search finds one" },
  "/resume": { args: "[<id> | latest]", description: "Continue an earlier conversation in this folder (picker, or straight to one)" },
  "/export": { args: "[markdown|json|support]", description: "Write a redacted session transcript or compact support artifact" },
  "/expand": { args: "[N | all | list]", description: "Show a folded block — written code, a test run, a long result — in full" },
  "/slow": { args: "[on|strict|off]", description: "Spend at a slower pace: fewer model rounds, smaller replies, a pause between turns" },
  "/workspace": { description: "Open the control panel: every tab and watched job, live, on one screen" },
  "/watch": { args: "[id|show <id>|stop <id>]", description: "Follow a background job's output without giving up the prompt" },
  "/theme": { args: "[name|list|where]", description: "Pick the colours from a list, or name one — blueprint, parchment, chalkboard, high-contrast, rainbow, or a .tss file of your own" },
  "/tab": { args: "[new|next|prev|close|rename|N]", description: "Several pieces of work, one at a time — only the tab in front runs (/detach for parallel)" },
  "/pull": { args: "[dir]", description: "Copy sandbox files here" },
  "/where": { description: "Show the current workspace" },
  "/diagnostics": { args: "[glob]", description: "Language server diagnostics for the workspace — errors, warnings, info from installed language servers" },
  "/tools": { description: "What the agent can call, and which skills, plugins, MCP servers or hooks a project added" },
  "/providers": { description: "Which model providers are configured" },
  "/settings": { description: "Theme, code colours, simple mode, startup, free-mode savings, keys and models" },
  "/upgrade": { description: "Use your own OpenRouter API key instead of the shared free gateway" },
  "/update": { args: "[auto|check|off]", description: "Update Friday now, or choose whether it updates itself" },
  "/voice": { args: "[audio-file]", description: "Record or transcribe an editable voice prompt" },
  "/wander": { args: "[topic|random|daily|weekly]", description: "Run a bounded research lab and grade what it finds" },
  "/jobs": { args: "[run|cancel|approve]", description: "Durable background work: list, start, cancel, or answer" },
  "/attach": { args: "<id>", description: "Watch a background job's log live" },
  "/detach": { args: "<task>", description: "Start work in the background; press Alt+B to send a running turn there" },
  "/cost": { description: "Token and cost breakdown for this session" },
  "/balance": { args: "[amount] [currency] | clear", description: "Your Friday credit balance on the exchange, or a locally tracked spend limit on a direct provider" },
  "/scan": { args: "[glob]", description: "Deterministic secret scan of the workspace, worst severity first — no model turn needed" },
  "/sessions": { description: "Pick an earlier conversation in this project (an alias for /history)" },
  "/palette": { description: "Search every command by name or by what it does" },
  "/keys": { description: "Every shortcut in full, plus line-editing keys and which chords this terminal may not deliver — /help lists them inline, next to each command" },
  "/guide": { args: "[topic|search <text>|all]", description: "The user guide, as a screen you can browse — or print one topic with /guide <topic>" },
  "/files": { description: "Browse the project tree — expand folders, preview a file, pick one to @mention" },
  "/edit": { args: "<path>", description: "Open a file in the built-in editor — through the workspace, so it works in a sandbox too" },
  "/cat": { args: "<path>", description: "Print a file into the transcript — markdown rendered like a document, code numbered and highlighted, PNG images drawn" },
  "/find": { args: "<text> | next | prev | off", description: "Search this tab's transcript in the fixed workspace; repeat /find for the next match" },
  "/pager": { description: "Open this tab's transcript in $PAGER (less -R) to search, select and save it" },
  "/help": { args: "[all|work|review|steer|parallel|learn|setup]", description: "Commands grouped by purpose" },
  "/exit": { description: "Leave" },
});

/**
 * Renders `/help` from the same table `completer` reads, so they cannot disagree.
 *
 * `shortcuts` (command name → chord label, e.g. `"F2"` or `"F3, Alt+M"`) merges in what used to be
 * a second lookup in `/keys` for the commands that have one: `keybindings.ts`'s
 * `KeyBindingRegistry.shortcutLabels()` is the source, kept optional here so this stays callable —
 * and testable — without constructing a whole registry.
 */
/**
 * The whole catalog, one row each — for `friday --help`, which is read piped and grepped as often
 * as it is read on screen.
 *
 * `mark` puts a leading character on the rows worth learning first. It is a parameter rather than
 * a hardcoded glyph because this same text is written to a pipe, where a star may not survive the
 * destination's encoding — the caller already knows whether this terminal can draw one.
 */
export function renderCommandHelp(
  language: ControlLanguage = "en",
  shortcuts: ReadonlyMap<string, string> = new Map(),
  options: { mark?: (command: string) => string } = {},
): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length + (command.args ? command.args.length + 1 : 0)));
  const shortcutWidth = Math.max(0, ...[...shortcuts.values()].map((label) => label.length));
  const mark = options.mark ?? (() => "  ");
  return COMMANDS.map((command) => {
    const head = command.args ? `${command.name} ${command.args}` : command.name;
    const shortcut = shortcuts.get(command.name) ?? "";
    const shortcutColumn = shortcutWidth > 0 ? shortcut.padEnd(shortcutWidth + 2) : "";
    return `${mark(command.name)}${head.padEnd(width + 2)}${shortcutColumn}${commandDescription(language, command.name, command.description)}`;
  }).join("\n");
}

/** Each row carries the id its translation is looked up by, so the order here is free to change. */
export const KEYBOARD_SHORTCUTS = [
  ["menu-move", "↑ / ↓", "Move through any menu — settings, models, the palette"],
  ["menu-number", "1-9", "Jump straight to a numbered row in a menu"],
  ["menu-take", "Enter / Esc", "Take the highlighted row / leave the menu"],
  ["complete-command", "Tab", "Complete a slash command"],
  ["complete-path", "@ + path", "Complete a project file mention"],
  ["history", "Up / Down", "Search persistent prompt history"],
  // Home/End and Alt-Backspace rather than Ctrl-A and Ctrl-W: those two belong to the Ctrl layer
  // now (/auto and /wander), and readline handles these natively, so the function never actually
  // moved out of reach. `KeyBindingRegistry.render()` prints the same relocation beside the chord
  // that took it; this row is the other half of it, for someone reading the editing keys rather
  // than the feature keys. The translated descriptions are untouched because they are still true.
  ["line-ends", "Home / End", "Move to the start / end of the input"],
  ["delete", "Alt-Backspace / Ctrl-U", "Delete the previous word / whole input"],
  ["clear", "Ctrl-L", "Clear and redraw the terminal"],
  ["interrupt", "Ctrl-C", "Interrupt the current turn"],
  ["voice", "/voice", "Record a prompt from the microphone"],
  ["expand", "Ctrl-O", "Unfold the most recent folded block"],
  ["memory", "# fact", "Remember a fact for every future session in this project"],
] as const;

export function renderKeyboardShortcuts(language: ControlLanguage = "en"): string {
  const width = Math.max(...KEYBOARD_SHORTCUTS.map(([, key]) => key.length));
  return KEYBOARD_SHORTCUTS.map(([id, key, description]) => `  ${key.padEnd(width + 2)}${keyboardDescription(language, id, description)}`).join("\n");
}
