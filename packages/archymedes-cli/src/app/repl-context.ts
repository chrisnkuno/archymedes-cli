/**
 * What a slash command handled by the REPL loop may read and do.
 *
 * Built once by `main()` from the session's services and its `SessionState`. A handler group takes
 * the line as typed and returns what the loop does next: go round again, end the session, or carry
 * on with a (possibly rewritten) line — the same `continue`, `break` and fall-through the inline
 * handlers used, in the same order.
 */
import type { Interface } from "node:readline/promises";
import type { Balance } from "@archymedes/core/cli/balance";
import type { SessionRecord } from "@archymedes/core/cli/session";
import type { FxRate, Money } from "@archymedes/core/money";
import type { ParsedArgs } from "./args";
import type { OpenClient } from "./agent-factory";
import type { BalanceTracking } from "./balance-tracking";
import type { ReadlineInternals } from "./prompts";
import type { Environment, RecoverableTurn, SessionState } from "./session-state";
import type { StatusLine } from "./status-line";
import type { TabPayload, createTabSwitching } from "./tab-switching";
import type { WorkspaceFactory } from "./workspaces";
import type { createBackgroundJobs } from "./background-jobs";
import type { createSessionHints } from "./session-hints";
import type { KeyBindingRegistry } from "../terminal/keybindings";
import type { WorkspaceController } from "../session/tabs";
import type { CliStateHistory } from "../session/state-history";
import type { detectColorDepth } from "../text/color-depth";
import type { buildPalette } from "../theme/theme";

/** `continue` and `break` as the loop meant them, or the line to keep dispatching. */
export type SlashOutcome = "continue" | "break" | { input: string };

type BackgroundJobs = ReturnType<typeof createBackgroundJobs>;
type TabSwitching = ReturnType<typeof createTabSwitching>;
type SessionHints = ReturnType<typeof createSessionHints>;

export type ReplContext = {
  state: SessionState;
  args: ParsedArgs;
  environment: Environment;
  processEnvironment: Environment;
  readline: Interface;
  /** The same interface, with the runtime-only members `ReadlineInternals` names. */
  rl: Interface & ReadlineInternals;
  interactive: boolean;
  depth: ReturnType<typeof detectColorDepth>;
  keys: KeyBindingRegistry;
  rates: FxRate[];
  approvedBudget: Money | undefined;
  tabs: WorkspaceController<TabPayload>;
  watched: BackgroundJobs["watched"];
  stateHistory: CliStateHistory;
  /** Lines the loop runs next as though typed. */
  queuedInput: string[];
  /** Kitty images placed by `/cat` this session, removed again by `/clear`. */
  kittyImages: number[];
  recoveryState: { last: RecoverableTurn | null };
  openClient: OpenClient;
  createWorkspace: WorkspaceFactory;
  runTurn: (request: string) => Promise<boolean>;
  /** `focus: "providers"` opens on the provider keys alone — the model picker's "add a key" row. */
  openSettings: (focus?: "providers") => Promise<"saved" | "cancelled" | "exit">;
  editFile: (target: string) => Promise<void>;
  navContext: SessionHints["navContext"];
  writeHint: SessionHints["writeHint"];
  screenCapabilities: StatusLine["screenCapabilities"];
  terminalControls: StatusLine["terminalControls"];
  refreshLiveModels: (options?: { refresh?: boolean }) => Promise<{ errors: string[] }>;
  applyTheme: (theme: { name: string; tokens: Parameters<typeof buildPalette>[0]["tokens"] }) => void;
  carryResumedSpend: (record: SessionRecord) => Promise<void>;
  checkBalance: BalanceTracking["checkBalance"];
  currentBalance: () => Balance | undefined;
  persistManualBalance: BalanceTracking["persistManualBalance"];
  criticalBalance: number;
  sessionSpend: BalanceTracking["sessionSpend"];
  startBackgroundJob: BackgroundJobs["startBackgroundJob"];
  startWatching: BackgroundJobs["startWatching"];
  stashActiveTab: TabSwitching["stashActiveTab"];
  enterTab: TabSwitching["enterTab"];
  switchTab: TabSwitching["switchTab"];
  showTabs: TabSwitching["showTabs"];
  /** Ctrl+C's session handler, which `/attach` lends out while it runs. */
  bindSigint: () => void;
  unbindSigint: () => void;
};
