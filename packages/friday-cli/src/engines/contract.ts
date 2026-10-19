import { type ProviderId } from "@archymedes/core/providers/provider-specs";
import { type SettingKey } from "../platform/settings";

/**
 * What every engine (Friday's own agent, Claude Code, Codex) and the server agree on: the session
 * commands' answers, and how a provider or engine describes its setup. Engines implement these;
 * the server (server/) carries them to the interface. Types only, so both sides can depend on it.
 */

export type ProviderField = {
  key: SettingKey;
  label: string;
  kind: "secret" | "url" | "text";
  required: boolean;
  isSet: boolean;
  /** The current value, masked for a secret; empty when unset. */
  value: string;
  /** What applies when it is left empty (a default base URL), or an example. */
  placeholder?: string;
};

export type SetupProvider = {
  id: ProviderId;
  label: string;
  /** The one variable a key fills; absent for providers that need more than a key (set up with `friday settings`). */
  keyVariable?: string;
  keyUrl?: string;
  configured: boolean;
};

export type SetupStatus = { configured: boolean; reason?: string; providers: SetupProvider[] };

/** One row of the Providers app: whether it is usable, what it still needs, and the model it would use. */
export type ProviderOverview = {
  id: ProviderId;
  label: string;
  configured: boolean;
  /** The variables still missing; empty when configured. */
  missing: string[];
  /** The one variable a key fills; absent when the provider needs more than a key. */
  keyVariable?: string;
  keyUrl?: string;
  /** What a session on this provider would use: its <PREFIX>_MODEL, else the default. */
  model: string;
  /** ARCHYMEDES_PROVIDER names it: new sessions start here. */
  isDefault: boolean;
  /** What it is set up with: its key, base URL and anything else it requires, secrets masked. */
  fields: ProviderField[];
};

/**
 * The session commands a drawing client asks for over `_archymedes/session/command`: the data
 * behind `/cost`, `/diff`, `/undo` and `/todos`, with presentation left to the client. Each answer
 * is plain data or plain text — never terminal escapes — because the client draws it.
 */

export type SessionCommandResult =
  | { kind: "text"; text: string }
  | { kind: "diff"; patch: string }
  | { kind: "todos"; items: Array<{ text: string; status: string }> }
  /** The turns that can be rewound to, oldest first: `index` is what `rewind` and `diff turn` take. */
  | { kind: "turns"; turns: Array<{ index: number; label: string; createdAt: number }> }
  /** `/review`: findings worst first, and a sentence on the change as a whole. */
  | { kind: "review"; target: string; findings: Array<{ file: string; line?: number; severity: string; title: string; body: string }>; overall: string }
  /** `/fork`: the new session the conversation was copied into, for the client to open. */
  | { kind: "forked"; id: string; title: string }
  /** `/goal`: the turn to send (`prompt`), or the verdict after one (`goal-check`). */
  | { kind: "goal"; status: "met" | "impossible" | "continue"; reason: string; next?: string }
  | { kind: "error"; text: string };
