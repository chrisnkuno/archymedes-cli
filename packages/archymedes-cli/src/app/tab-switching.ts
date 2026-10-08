/**
 * One workspace, several pieces of work.
 *
 * Each tab owns its own agent, cost ledger, mode — and its own output sink. Switching swaps the
 * session state the rest of the loop already reads, and re-points `out` at the incoming tab.
 * Threading a tab handle through every call site instead would touch every line of the loop without
 * changing what any of them do.
 *
 * The sink is what makes a tab a *place* rather than a saved setting: what a tab printed stays
 * addressable after you leave it, so coming back can show where you were instead of an empty
 * screen and a prompt.
 */
import type { ArchymedesDaemonClient } from "@archymedes/core/cli/daemon";
import type { ArchymedesMode } from "@archymedes/core/cli/permissions";
import type { ArchymedesWorkspace } from "@archymedes/core/cli/backends";
import type { CostLedger } from "@archymedes/core/cli/cost";
import { formatMoney } from "@archymedes/core/money";
import { rule } from "../render/sections";
import type { SandboxBackend } from "../session/location";
import { renderTabStrip, type WorkspaceController } from "../session/tabs";
import { replayLines, type TabSink } from "../terminal/output";
import { WorkspaceFrame } from "../ui/workspace-frame";
import type { SessionModel, SessionPrices, SessionSpec, SessionState } from "./session-state";
import { contentWidth, glyphs, out, screen, sectionStyle, style } from "./transcript";

/**
 * Everything that makes one tab a different piece of work from another.
 *
 * Model, provider and workspace joined `agent`/`ledger`/`mode` here because a control panel whose
 * every panel runs the same model in the same place is just a list. A tab on Sonnet against this
 * checkout and a tab on an open model in a throwaway sandbox are the case this exists for, and
 * they are only different if these travel with the tab rather than with the session.
 *
 * `ownsWorkspace` marks the tabs that started their own sandbox. The session's original workspace
 * is shared — closing the tab that happens to hold it must not dispose the thing every other tab
 * is still using — while a sandbox a tab started is a sandbox a tab stops paying for.
 */
export type TabPayload = {
  agent: ArchymedesDaemonClient;
  ledger: CostLedger;
  mode: ArchymedesMode;
  sink: TabSink;
  provider: SessionModel;
  spec: SessionSpec;
  prices: SessionPrices;
  modelId: string;
  backend: SandboxBackend;
  workspace: ArchymedesWorkspace;
  ownsWorkspace: boolean;
};

type Tab = { title: string; payload: TabPayload };

/**
 * How much of a tab's own transcript is reprinted when you return to it.
 *
 * Enough to re-establish where the work was, not so much that switching tabs buries the thing you
 * switched in order to do. The full record is still in the tab's sink; this is the reminder.
 */
const REPLAY_LINES = 24;

/** What the strip and the workspace show about a tab, from what only the session knows. */
export const describeTab = (payload: TabPayload) => ({
  model: payload.modelId,
  backend: payload.backend,
  cost: payload.ledger.displayTotal ? formatMoney(payload.ledger.displayTotal) : "",
});

export function createTabSwitching(
  tabs: WorkspaceController<TabPayload>,
  state: Pick<SessionState, "agent" | "ledger" | "mode" | "model" | "spec" | "prices" | "resolvedModelId" | "workspace">,
) {
  /** Writes the session state back into the tab being left, and takes it off the terminal. */
  const stashActiveTab = (): void => {
    const current = tabs.active;
    current.payload.agent = state.agent;
    current.payload.ledger = state.ledger;
    current.payload.mode = state.mode;
    current.payload.provider = state.model;
    current.payload.spec = state.spec;
    current.payload.prices = state.prices;
    current.payload.modelId = state.resolvedModelId;
    current.payload.workspace = state.workspace;
    current.payload.sink.setLive(false);
  };

  /**
   * Makes a tab the one in front: its state becomes the session's, and its sink becomes the
   * address every write resolves to.
   */
  const enterTab = (tab: Tab, options: { replay?: boolean } = {}): void => {
    state.agent = tab.payload.agent;
    state.ledger = tab.payload.ledger;
    state.mode = tab.payload.mode;
    state.workspace = tab.payload.workspace;
    state.model = tab.payload.provider;
    state.spec = tab.payload.spec;
    state.prices = tab.payload.prices;
    state.resolvedModelId = tab.payload.modelId;
    tab.payload.sink.setLive(true);
    out.route(tab.payload.sink);
    if (screen instanceof WorkspaceFrame) screen.scroll({ kind: "live" });
    else if (options.replay) replayTab(tab);
  };

  /**
   * Reprints the tail of a tab's transcript on return.
   *
   * Printed *through* the sink like anything else, so the replay itself becomes part of that tab's
   * record — a tab's history stays a truthful account of what its screen has shown, rather than a
   * log that quietly disagrees with the terminal.
   */
  const replayTab = (tab: Tab): void => {
    const replay = replayLines(tab.payload.sink.log, REPLAY_LINES);
    if (replay.lines.length === 0) return;
    const above = replay.omitted + replay.dropped;
    out.write(`${rule(sectionStyle(), {
      label: tab.title,
      tone: "accent",
      ...(above > 0 ? { trailing: `${above} earlier lines above` } : {}),
    })}\n`);
    for (const line of replay.lines) out.write(`${line}\n`);
  };

  const switchTab = (id: number): boolean => {
    if (tabs.active.id === id) return Boolean(tabs.find(id));
    stashActiveTab();
    const next = tabs.activate(id);
    if (!next) {
      // Nothing was switched to, so the tab that was just stashed is still the one in front.
      enterTab(tabs.active);
      return false;
    }
    enterTab(next, { replay: true });
    return true;
  };

  const showTabs = () => {
    // Detail on: once tabs can differ in model and location, which is which is the only thing the
    // strip is actually being read for.
    const strip = renderTabStrip(tabs.views(describeTab), { width: contentWidth(), glyphs, detail: true });
    if (strip) out.write(`  ${style.dim(strip)}\n`);
  };

  return { stashActiveTab, enterTab, switchTab, showTabs };
}
