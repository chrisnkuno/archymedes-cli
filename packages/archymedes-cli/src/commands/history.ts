import type { SessionRecord } from "@archymedes/core/cli/session";
import { heading, note, type SectionStyle } from "../render/sections";
import type { CliStateHistory } from "../session/state-history";
import type { GlyphSet } from "../text/glyphs";
import type { ChooserItem } from "../ui/chooser";
import type { DeleteOutcome } from "../session/delete-session";
import { relativeTime, renderHistoryList, renderHistoryUsage, renderReplay, searchHistory, summarizeSession, type HistoryCommand, type HistoryEntry } from "./chat-history";

type Paint = (text: string) => string;

export type HistoryContext = {
  stateHistory: Pick<CliStateHistory, "sessions" | "search" | "refresh" | "status">;
  listSessions(limit: number): Promise<Array<{ id: string }>>;
  loadSession(id: string): Promise<SessionRecord | null | undefined>;
  currentSessionId: string | undefined;
  /**
   * The interactive session picker; omitted when nobody is at the keyboard. `onDelete`, when given,
   * makes the highlighted chat deletable from inside the list (Del, with a y/n confirm).
   */
  choose?: (items: readonly ChooserItem<string>[], extras?: {
    onDelete?: (item: ChooserItem<unknown>) => Promise<DeleteOutcome>;
    legend?: string;
  }) => Promise<string | undefined>;
  /** Deletes one past chat of this project; refuses the open one. Omitted, deleting is unavailable. */
  remove?: (id: string) => Promise<DeleteOutcome>;
  /** Deletes every chat in this project except the open one. */
  removeAll?: () => Promise<{ deleted: number }>;
  /** A y/n question; omitted where nobody can answer, which refuses `delete --all`. */
  confirm?: (question: string) => Promise<boolean>;
  /** Swaps the session onto a past record. Called once the record is known to exist. */
  resume(record: SessionRecord): Promise<void>;
  write(text: string): void;
  paint: { dim: Paint; yellow: Paint; green: Paint };
  style: SectionStyle;
  glyphs: GlyphSet;
};

/** `/history [search <text> | status | <id> | resume [id]]`: durable conversation history. */
export async function runHistoryCommand(command: HistoryCommand, context: HistoryContext): Promise<void> {
  const { style, paint, write, glyphs } = context;
  let cached: HistoryEntry[] | undefined;
  // The native index when it is available, the session files when it is not; loaded once per command.
  const entries = async (): Promise<HistoryEntry[]> => {
    if (cached) return cached;
    const indexed = await context.stateHistory.sessions(30);
    const listed = indexed ? indexed.map((session) => ({ id: session.sessionId })) : await context.listSessions(30);
    cached = (await Promise.all(listed.map(async (summary) => {
      const record = await context.loadSession(summary.id);
      return record ? summarizeSession(record) : null;
    }))).filter((entry): entry is HistoryEntry => entry !== null);
    return cached;
  };

  switch (command.kind) {
    case "invalid":
      write(paint.yellow(`  ${command.reason}\n`));
      return;
    case "browse":
      // A picker when someone can use one; a pipe gets the printed list instead of nothing.
      if (context.choose) return runHistoryCommand({ kind: "resume" }, context);
      return runHistoryCommand({ kind: "list" }, context);
    case "delete": {
      if (!context.remove || !context.removeAll) { write(paint.yellow("  Deleting chats is available inside an interactive session.\n")); return; }
      if (command.all) {
        const others = (await entries()).filter((entry) => entry.id !== context.currentSessionId);
        if (others.length === 0) { write(paint.dim("  no other chats in this folder to delete\n")); return; }
        // Everything at once is the one deletion that is always confirmed, and never silently.
        if (!context.confirm) { write(paint.yellow("  /history delete --all needs a terminal to confirm in.\n")); return; }
        const sure = await context.confirm(`Delete all ${others.length} other chat${others.length === 1 ? "" : "s"} in this folder? This can't be undone.`);
        if (!sure) { write(paint.dim("  nothing deleted\n")); return; }
        const { deleted } = await context.removeAll();
        write(paint.green(`  deleted ${deleted} chat${deleted === 1 ? "" : "s"} — the one you are in is kept\n`));
        return;
      }
      const outcome = await context.remove(command.id!);
      write(outcome.deleted ? paint.green(`  deleted ${command.id}\n`) : paint.yellow(`  ${outcome.reason}\n`));
      return;
    }
    case "list": {
      const listed = await entries();
      write(`${renderHistoryList(listed, style, { current: context.currentSessionId })}\n`);
      const usage = renderHistoryUsage(listed, style);
      if (usage) write(`${usage}\n`);
      return;
    }
    case "search": {
      const nativeHits = await context.stateHistory.search(command.query, 20);
      const found = nativeHits
        ? (await Promise.all(nativeHits.map(async (hit): Promise<HistoryEntry | null> => {
            const record = await context.loadSession(hit.sessionId);
            return record ? { ...summarizeSession(record), evidence: { source: hit.source, snippet: hit.snippet, why: hit.why } } : null;
          }))).filter((entry): entry is HistoryEntry => entry !== null)
        : searchHistory(await entries(), command.query);
      write(`${heading(`"${command.query}" ${glyphs.middot} ${found.length} match${found.length === 1 ? "" : "es"}`, 2, style)}\n`);
      write(`${renderHistoryList(found, style, { current: context.currentSessionId })}\n`);
      return;
    }
    case "status": {
      await context.stateHistory.refresh();
      const status = await context.stateHistory.status();
      write(`${heading("history engine", 2, style)}\n`);
      if (status.mode === "fallback") {
        write(`${note("portable JSON history is active", style)}\n`);
        write(`${note(status.reason ?? "native state engine unavailable", style)}\n`);
      } else {
        write(`${note(`native SQLite + FTS5 ${status.indexed ? "is current" : "is ready"}`, style)}\n`);
        if (status.report) {
          write(`${note(`${status.report.sessions} sessions ${glyphs.middot} ${status.report.documents} searchable documents ${glyphs.middot} ${status.report.failures.length} source failures`, style)}\n`);
        }
      }
      return;
    }
    case "show": {
      const record = await context.loadSession(command.id);
      if (!record) { write(paint.yellow(`  No session ${command.id}. /history lists them.\n`)); return; }
      write(`${renderReplay(record, style, command.turns === undefined ? {} : { turns: command.turns })}\n`);
      return;
    }
    case "resume": {
      // Picked from a menu when no id was given: the ids are deliberately not memorable.
      const listed = await entries();
      let id = command.id === "latest" ? listed[0]?.id : command.id;
      if (!id && listed.length === 0) { write(paint.dim("  no earlier chats in this folder yet\n")); return; }
      if (!id && context.choose) {
        const remove = context.remove;
        id = await context.choose(listed.map((entry) => ({
          value: entry.id,
          label: entry.title || entry.id,
          // The chat you are in is marked, so the list reads as "where I am, and where I was".
          hint: entry.id === context.currentSessionId ? "this chat" : relativeTime(entry.updatedAt),
          description: `${entry.turns} turn${entry.turns === 1 ? "" : "s"}`,
        })), remove ? {
          onDelete: (item) => remove(String(item.value)),
          legend: "↑↓ move · Enter open · Del delete · type to filter · Esc back",
        } : undefined);
      }
      if (!id) { write(paint.dim("  no session chosen — back to your chat · /history list prints them all\n")); return; }
      const record = await context.loadSession(id);
      if (!record) { write(paint.yellow(`  No session ${id}.\n`)); return; }
      await context.resume(record);
      write(`${renderReplay(record, style, { turns: 2 })}\n`);
      write(paint.green(`  resumed ${record.id}\n`));
      return;
    }
  }
}
