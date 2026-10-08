/**
 * The mutable state of one interactive session, as the extracted pieces of `main()` see it.
 *
 * `main()` still owns every one of these as a local, and builds a `SessionState` of getter/setter
 * pairs over them. That keeps the semantics the inline code had — every read is of the value at that
 * moment, and every write is visible to the rest of `main()` immediately — while letting a handler
 * in another module name exactly what it reads and changes.
 */
import type { ArchymedesDaemonClient } from "@archymedes/core/cli/daemon";
import type { ArchymedesMode } from "@archymedes/core/cli/permissions";
import type { ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import type { CostLedger } from "@archymedes/core/cli/cost";
import type { Balance } from "@archymedes/core/cli/balance";
import type { AgentRuntimeResult } from "@archymedes/core/agent-runtime";
import type { Currency } from "@archymedes/core/money";
import type { ProviderId, ResolvedProvider } from "@archymedes/core/providers/agent-matrix";
import type { MemoryEntry } from "../commands/memory";
import type { PaceLevel } from "../commands/pacing";
import type { ArchymedesSettings } from "../platform/settings";
import type { resolveControlLanguage } from "../platform/i18n";
import type { findTheme } from "../theme/theme-files";
import type { NavContext } from "../ui/navigation";

export type SessionModel = ResolvedProvider["provider"];
export type SessionSpec = ResolvedProvider["spec"];
export type SessionPrices = ResolvedProvider["prices"];
export type Environment = Record<string, string | undefined>;

export type SessionState = {
  savedSettings: ArchymedesSettings;
  language: ReturnType<typeof resolveControlLanguage>;
  /** The active tab's model client, provider spec, rate card and model id. */
  model: SessionModel;
  spec: SessionSpec;
  prices: SessionPrices;
  resolvedModelId: string;
  /** The currency costs are shown in. */
  display: Currency;
  projectFiles: string[];
  themeName: string;
  activeTheme: Awaited<ReturnType<typeof findTheme>>;
  mode: ArchymedesMode;
  pace: PaceLevel;
  memories: MemoryEntry[];
  workspace: ArchymedesWorkspace;
  ledger: CostLedger;
  manualBalance: Balance | undefined;
  agent: ArchymedesDaemonClient;
  liveModels: Partial<Record<ProviderId, string[]>>;
  /** Replaced every turn; read at ask-time by the approval prompt. */
  currentTurnAbort: AbortController | undefined;
  /** A read-only command waiting on the network, so Ctrl+C can stop the wait. */
  pendingReadAbort: AbortController | undefined;
  turnActive: boolean;
  exitRequested: boolean;
  detachRequested: boolean;
  explainedTabs: boolean;
  wanderRunning: boolean;
  lastScanFindings: number | undefined;
  lastFailure: { status: NavContext["lastStatus"]; message: string } | null;
  cacheChurnReported: boolean;
  streamedAnswer: boolean;
  lastTurnStatus: AgentRuntimeResult["status"];
  sessionRequest: string | undefined;
  lastTurnEndedAt: number | undefined;
  /** How the prompt bar names where work happens; set once the banner is drawn. */
  where: string;
};

/** A turn that `/retry` or `/continue` may pick up again. */
export type RecoverableTurn = {
  request: string;
  status: AgentRuntimeResult["status"];
  toolCalls: number;
  changedFiles: number;
};
