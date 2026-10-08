/**
 * Where this session is, for anything that has to decide what to offer next.
 */
import type { AgentRuntimeResult } from "@archymedes/core/agent-runtime";
import type { WorkspaceController } from "../session/tabs";
import type { WatchRegistry } from "../terminal/job-stream";
import { renderHint, type CommandUsage, type NavContext } from "../ui/navigation";
import type { SessionState } from "./session-state";
import type { TabPayload } from "./tab-switching";
import { out, sectionStyle, touchedFiles } from "./transcript";

/**
 * The runtime's stop reason as the protocol's turn status.
 *
 * They agree on every value but one — the runtime calls a paused approval "needs_approval" — and
 * the suggestion rules speak the protocol's vocabulary, since the desktop reaches them through
 * the same names.
 */
export const failureStatus = (status: AgentRuntimeResult["status"]): NavContext["lastStatus"] =>
  status === "needs_approval" ? "waiting_approval" : status;

export function createSessionHints(options: {
  state: Pick<SessionState, "mode" | "ledger" | "agent" | "lastScanFindings" | "lastFailure">;
  watched: WatchRegistry;
  tabs: WorkspaceController<TabPayload>;
  usage: CommandUsage;
  interactive: boolean;
}) {
  const { state, watched, tabs, usage } = options;
  /**
   * Where this session actually is, for anything that has to decide what to offer.
   *
   * Read fresh at every use rather than kept as state: every field here already lives somewhere
   * that owns it — the ledger, the tab controller, the watch registry — and a second copy would be
   * one more thing to keep in step, which is exactly how a "smart" suggestion starts describing a
   * session that ended two turns ago.
   */
  const navContext = (): NavContext => ({
    mode: state.mode,
    turns: state.ledger.history.length,
    changedFiles: touchedFiles.size,
    openTodos: state.agent.todos.filter((item) => item.status !== "done").length,
    runningJobs: watched.size,
    tabs: tabs.size,
    sandbox: state.agent.workspaceKind !== "local",
    providerConfigured: true,
    hasSpend: Boolean(state.ledger.displayTotal?.micros),
    ...(state.lastScanFindings === undefined ? {} : { openFindings: state.lastScanFindings }),
    ...(state.ledger.budgetFraction === undefined ? {} : { budgetFraction: state.ledger.budgetFraction }),
    ...(state.lastFailure ? { lastStatus: state.lastFailure.status, lastError: state.lastFailure.message } : {}),
    recent: usage.recent,
  });
  /**
   * One ambient line, printed where a command had nothing of its own to say.
   *
   * Interactive only, and silent when the rules have nothing left to teach — a session that has
   * already reached for everything relevant gets its empty result back unadorned, which is the
   * point at which a hint would have become a tic.
   */
  const writeHint = (): void => {
    if (!options.interactive) return;
    const hint = renderHint(navContext(), sectionStyle());
    if (hint) out.write(`${hint}\n`);
  };
  return { navContext, writeHint };
}
