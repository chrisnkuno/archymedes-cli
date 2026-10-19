/**
 * Several pieces of work in one session.
 *
 * A coding session is rarely one thing. You are mid-refactor when a test starts failing for an
 * unrelated reason, and the choice today is to lose the refactor's context or open a second
 * terminal and lose the shared model, cost cap and approvals. Tabs are the third option.
 *
 * These are **sequential** tabs: exactly one is in front, and the transcript stays the append-only
 * scroll the renderer is built around. That is a deliberate limit rather than a first step —
 * showing two live agents at once needs a redrawable full-screen interface, and pretending
 * otherwise would mean two agents writing over each other's output in the same scrollback. What
 * this does give is separate history, mode, model and cost per piece of work, and the ability to
 * put one down and pick it up again without losing where it was.
 *
 * The controller is generic over what a tab holds so it can be tested without constructing a model
 * provider, a workspace and a ledger — the parts that make the CLI hard to test are exactly the
 * parts this does not need to know about.
 */

export type TabStatus = "idle" | "running" | "failed";

export type Tab<T> = {
  /** Stable across reordering — closing tab 2 does not renumber tab 3. */
  readonly id: number;
  title: string;
  status: TabStatus;
  /** Turns completed here since it was last in front, so a returning user knows what moved. */
  unread: number;
  /** Whatever the host needs per tab: its agent, its ledger, its mode. */
  readonly payload: T;
};

export type TabView = {
  id: number;
  title: string;
  status: TabStatus;
  unread: number;
  active: boolean;
  /** The model this tab talks to, short form — tabs may each use a different one. */
  model?: string;
  /** Where this tab's work runs. Omitted or "local" means this machine. */
  backend?: "local" | "e2b" | "docker";
  /** What this tab has spent, already formatted in the display currency. */
  cost?: string;
};

export class WorkspaceController<T> {
  private readonly tabs: Tab<T>[] = [];
  private activeId: number | undefined;
  private nextId = 1;

  constructor(private readonly limit = 9) {}

  /**
   * Opens a tab and brings it to the front.
   *
   * The payload is built lazily so opening does not pay for an agent the user may never send a
   * turn to, and so a failure to construct one is reported at `/tab new` rather than silently
   * leaving a tab that breaks on first use.
   */
  open(title: string, create: () => T): Tab<T> {
    if (this.tabs.length >= this.limit) throw new Error(`Already at ${this.limit} tabs — close one first.`);
    const tab: Tab<T> = { id: this.nextId, title: title.trim() || `tab ${this.nextId}`, status: "idle", unread: 0, payload: create() };
    this.nextId += 1;
    this.tabs.push(tab);
    this.activate(tab.id);
    return tab;
  }

  /** Adopts an already-built payload — for the tab that exists before anyone asks for tabs. */
  adopt(title: string, payload: T): Tab<T> {
    return this.open(title, () => payload);
  }

  get active(): Tab<T> {
    const tab = this.tabs.find((candidate) => candidate.id === this.activeId);
    if (!tab) throw new Error("No tab is open");
    return tab;
  }

  get size(): number {
    return this.tabs.length;
  }

  get all(): readonly Tab<T>[] {
    return [...this.tabs];
  }

  find(id: number): Tab<T> | undefined {
    return this.tabs.find((tab) => tab.id === id);
  }

  activate(id: number): Tab<T> | undefined {
    const tab = this.find(id);
    if (!tab) return undefined;
    this.activeId = id;
    // Coming back is what clears the marker; that is the only moment we know it has been seen.
    tab.unread = 0;
    return tab;
  }

  /** Cycles by position, wrapping. `step` may be negative for the previous tab. */
  cycle(step = 1): Tab<T> {
    if (this.tabs.length === 0) throw new Error("No tab is open");
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId);
    const next = (((index + step) % this.tabs.length) + this.tabs.length) % this.tabs.length;
    return this.activate(this.tabs[next].id)!;
  }

  /**
   * Closes a tab and returns what should be disposed.
   *
   * Refuses to close the last one: an empty workspace has no prompt to return to, and "close the
   * only tab" almost always means "quit", which is `/exit` and should be typed deliberately.
   * A running tab is refused too — closing it would orphan work that is still spending money.
   */
  close(id: number): { closed: Tab<T>; nextActive: Tab<T> } {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) throw new Error(`No tab ${id}.`);
    if (this.tabs.length === 1) throw new Error("This is the last tab — use /exit to leave.");
    if (this.tabs[index].status === "running") throw new Error(`Tab ${id} is still working. Interrupt it with Ctrl+C first.`);

    const [closed] = this.tabs.splice(index, 1);
    if (this.activeId === id) this.activate(this.tabs[Math.min(index, this.tabs.length - 1)].id);
    return { closed, nextActive: this.active };
  }

  /**
   * Records that a tab finished a turn.
   *
   * Only counts as unread when the tab is not the one being watched, which is what makes the
   * marker mean "something happened while you were elsewhere" rather than "a turn happened".
   */
  finished(id: number, status: Exclude<TabStatus, "running">): void {
    const tab = this.find(id);
    if (!tab) return;
    tab.status = status;
    if (id !== this.activeId) tab.unread += 1;
  }

  started(id: number): void {
    const tab = this.find(id);
    if (tab) tab.status = "running";
  }

  /**
   * A description of every tab, for the strip and the workspace.
   *
   * `describe` lets the host attach what only it knows — the model, the location, the running total
   * — without `WorkspaceController` having to know what a model or a ledger is. Keeping it generic
   * is what makes it testable without constructing a provider.
   */
  views(describe?: (payload: T) => Partial<Omit<TabView, "id" | "title" | "status" | "unread" | "active">>): TabView[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      status: tab.status,
      unread: tab.unread,
      active: tab.id === this.activeId,
      ...(describe ? describe(tab.payload) : {}),
    }));
  }
}
