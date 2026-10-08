/**
 * Builds an agent for a tab.
 *
 * One coordinator (`ArchymedesSessionDaemon`) owns every live agent this process creates. Tabs, mode
 * swaps and model swaps each become a daemon client rather than a directly-held `ArchymedesAgent`,
 * which is what makes this process's sessions reachable the same way a desktop window's or an IDE's
 * are — through the daemon, not through a second, parallel way of constructing an agent that the
 * daemon knows nothing about.
 */
import { ArchymedesAgent } from "@archymedes/core/cli/agent";
import { createLspEditDiagnostics } from "@archymedes/core/cli/edit-diagnostics";
import { LocalWorkspace, type ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import type { ArchymedesDaemonClient, ArchymedesSessionDaemon, DaemonNotification } from "@archymedes/core/cli/daemon";
import type { SessionRecord } from "@archymedes/core/cli/session";
import { convertTo, type FxRate, type Money } from "@archymedes/core/money";
import { createExaClient } from "@archymedes/core/providers/exa";
import { applyPacing } from "../commands/pacing";
import type { ParsedArgs } from "./args";
import { jevOptionsFromEnvironment } from "./jev";
import type { createApprovalPrompt } from "./prompts";
import { modelPriceCatalogFor } from "./providers";
import type { Environment, SessionModel, SessionPrices, SessionState } from "./session-state";

export type ClientRuntime = { provider?: SessionModel; prices?: SessionPrices; workspace?: ArchymedesWorkspace };
export type OpenClient = (record?: SessionRecord, runtime?: ClientRuntime) => Promise<ArchymedesDaemonClient>;

/**
 * The overrides exist because a tab may not be running what the session is: its own model, its
 * own prices, its own machine. Defaulted to the session's state so every existing call site — a
 * mode switch, a `/clear`, a resume — keeps meaning "rebuild the tab I am in".
 */
export function createClientFactory(options: {
  args: ParsedArgs;
  environment: Environment;
  daemon: ArchymedesSessionDaemon;
  approvalPrompt: ReturnType<typeof createApprovalPrompt>;
  onNotification: (notification: DaemonNotification) => void;
  rates: FxRate[];
  approvedBudget: Money | undefined;
  state: Pick<SessionState, "model" | "prices" | "pace" | "mode" | "workspace" | "ledger">;
}): OpenClient {
  const { args, environment, daemon, approvalPrompt, rates, approvedBudget, state } = options;
  return async (record, runtime = {}) => {
    const client = daemon.connect({
      onNotification: options.onNotification,
      // The daemon's approval type is the flattened cross-boundary shape; the terminal prompt reads
      // `summary`, `safety` and (for a pending write/edit) `preview` off it.
      approve: (request) => approvalPrompt({ summary: request.summary, safety: request.safety, preview: request.preview, jev: request.jev, pattern: request.pattern }),
    });
    // Language-server diagnostics appended to each edit result. Local workspaces only — a
    // server on this machine cannot see a sandbox's files. ARCHYMEDES_EDIT_DIAGNOSTICS=off disables.
    const editDiagnostics = (runtime.workspace ?? state.workspace) instanceof LocalWorkspace && environment.ARCHYMEDES_EDIT_DIAGNOSTICS?.trim().toLowerCase() !== "off"
      ? createLspEditDiagnostics(args.root)
      : undefined;
    await client.open(({ onEvent, approve }) => new ArchymedesAgent({
      root: args.root,
      model: runtime.provider ?? state.model,
      // The runtime keeps its own integer-unit ceiling as a runaway guard; the ledger below owns the
      // real, currency-aware budget. Feeding it the provider's own per-million rates keeps that guard
      // proportionate to actual spend instead of to a unit nobody configured.
      prices: modelPriceCatalogFor(runtime.prices ?? state.prices, Boolean(approvedBudget)),
      // The pace's limits are the runtime's own budget fields, merged over the approved cap rather
      // than replacing it: slowing down must never quietly raise a ceiling the user approved.
      budgets: applyPacing(
        approvedBudget && (runtime.prices ?? state.prices) ? { maxRwf: convertTo(approvedBudget, (runtime.prices ?? state.prices)!.currency, rates)?.micros ?? approvedBudget.micros } : {},
        state.pace,
      ),
      mode: state.mode,
      workspace: runtime.workspace ?? state.workspace,
      approve,
      search: createExaClient(environment),
      onExpense: (expense) => state.ledger.recordExpense(expense),
      onEvent,
      jev: jevOptionsFromEnvironment(environment),
      afterEdit: editDiagnostics,
    }), record);
    if (editDiagnostics) closeWithClient(client, editDiagnostics);
    return client;
  };
}

/**
 * Stops the language servers an edit-diagnostics hook keeps warm once its client is retired.
 *
 * Every mode, model, pace or settings switch, `/clear`, resume and tab close replaces the client
 * with a fresh one and a fresh hook; without this the old hook's servers lingered until the
 * ten-minute idle shutdown or process exit. Closing is idempotent and never throws.
 */
function closeWithClient(client: ArchymedesDaemonClient, hook: { close(): void }): void {
  const close = () => { try { hook.close(); } catch { /* best effort: the hook also closes on idle and exit */ } };
  const relinquish = client.relinquish.bind(client);
  const dispose = client.dispose.bind(client);
  client.relinquish = () => relinquish().finally(close);
  client.dispose = () => dispose().finally(close);
}
