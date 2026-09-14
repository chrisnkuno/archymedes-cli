import type { SandboxBackend } from "../session/location";
import { SEQUENTIAL_TABS_NOTE, shortModel, type Tab, type TabCommand } from "../session/tabs";
import { GUTTER } from "../render/sections";
import type { GlyphSet } from "../text/glyphs";

/** What `/tab` needs to know about a tab's payload; the session defines the rest. */
export type TabPayloadShape = {
  agent: { dispose(): Promise<unknown> };
  sink: { readonly isLive: boolean; setLive(live: boolean): void };
  backend: SandboxBackend;
  workspace: { dispose(): Promise<unknown> };
  ownsWorkspace: boolean;
};

type Paint = (text: string) => string;

export type TabCommandContext<P extends TabPayloadShape, Wanted extends { model: string }, Workspace> = {
  tabs: { readonly size: number; readonly active: Tab<P>; cycle(step: number): Tab<P>; close(id: number): { closed: Tab<P>; nextActive: Tab<P> } };
  /** Resolves `--provider`/`--model` before anything opens, so a typo costs nothing. */
  resolve(request: { provider?: string; model?: string }): Wanted | { error: string };
  /** The session's own workspace, shared by a tab that asks for no other location. */
  sessionWorkspace: Workspace;
  startWorkspace(backend: Exclude<SandboxBackend, "local">): Promise<{ workspace: Workspace } | { error: string }>;
  /** Opens a tab on a resolved model and workspace, without bringing it to the front. */
  openTab(title: string, wanted: Wanted, workspace: Workspace, backend: SandboxBackend | undefined): Promise<Tab<P>>;
  stashActiveTab(): void;
  enterTab(tab: Tab<P>, options?: { replay?: boolean }): void;
  switchTab(id: number): boolean;
  showTabs(): void;
  describeLocation(backend: SandboxBackend): string;
  /** True the first time it is asked in a session, so the sequential-tabs note is said once. */
  firstTabExplanation(): boolean;
  write(text: string): void;
  paint: { dim: Paint; yellow: Paint; cyan: Paint };
  glyphs: GlyphSet;
};

/** `/tab [new|next|prev|close|rename|N]`: several pieces of work in one session, one in front at a time. */
export async function runTabCommand<P extends TabPayloadShape, Wanted extends { model: string }, Workspace>(
  command: TabCommand,
  context: TabCommandContext<P, Wanted, Workspace>,
): Promise<void> {
  const { tabs, paint, write } = context;
  try {
    switch (command.kind) {
      case "invalid":
        write(paint.yellow(`  ${command.reason}\n`));
        return;
      case "list":
        context.showTabs();
        // Listing tabs is someone asking what a tab not in front is doing, so it is answered here.
        write(paint.dim(tabs.size === 1 ? "  one tab — /tab new opens another; only the tab in front runs\n" : `  ${SEQUENTIAL_TABS_NOTE}\n`));
        return;
      case "new": {
        const wanted = context.resolve({ ...(command.provider ? { provider: command.provider } : {}), ...(command.model ? { model: command.model } : {}) });
        if ("error" in wanted) { write(paint.yellow(`  ${wanted.error}\n`)); return; }
        // A tab asking for somewhere else gets its own sandbox; one that asked for nothing shares the
        // session's, because two local workspaces on one directory would be two agents in one checkout.
        let workspace = context.sessionWorkspace;
        if (command.backend && command.backend !== "local") {
          const started = await context.startWorkspace(command.backend);
          if ("error" in started) { write(paint.yellow(`  ${started.error}\n`)); return; }
          workspace = started.workspace;
        }
        // Saved before opening, or the tab being left behind keeps the incoming tab's state.
        context.stashActiveTab();
        const opened = await context.openTab(command.title ?? `tab ${tabs.size + 1}`, wanted, workspace, command.backend);
        context.enterTab(opened);
        write(`${GUTTER}${paint.dim("running")} ${paint.cyan(shortModel(wanted.model))} ${paint.dim(`${context.glyphs.middot} ${context.describeLocation(opened.payload.backend)}`)}\n`);
        context.showTabs();
        // Once per session, on the tab that first creates the ambiguity.
        if (context.firstTabExplanation()) write(paint.dim(`${GUTTER}${SEQUENTIAL_TABS_NOTE}\n`));
        return;
      }
      case "next": case "previous":
        context.stashActiveTab();
        context.enterTab(tabs.cycle(command.kind === "next" ? 1 : -1), { replay: true });
        context.showTabs();
        return;
      case "select":
        if (!context.switchTab(command.id)) write(paint.yellow(`  No tab ${command.id}.\n`));
        else context.showTabs();
        return;
      case "rename":
        tabs.active.title = command.title;
        context.showTabs();
        return;
      case "close": {
        const { closed, nextActive } = tabs.close(command.id ?? tabs.active.id);
        // Read before the sink is retired: whether the screen changes hands is whether this tab was on it.
        const wasInFront = closed.payload.sink.isLive;
        closed.payload.sink.setLive(false);
        await closed.payload.agent.dispose().catch(() => undefined);
        // A sandbox this tab started is one it stops paying for; the session's own workspace is shared.
        if (closed.payload.ownsWorkspace) {
          write(paint.dim(`  stopping ${context.describeLocation(closed.payload.backend)}\n`));
          await closed.payload.workspace.dispose().catch(() => undefined);
        }
        context.enterTab(nextActive, { replay: wasInFront });
        context.showTabs();
        return;
      }
    }
  } catch (error) {
    write(paint.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
  }
}
