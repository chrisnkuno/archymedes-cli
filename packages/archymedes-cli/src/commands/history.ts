import type { SessionRecord } from "@archymedes/core/cli/session";
import { heading, note, type SectionStyle } from "../render/sections";
import type { CliStateHistory } from "../session/state-history";
import type { GlyphSet } from "../text/glyphs";
import type { ChooserItem } from "../ui/chooser";
import { relativeTime, renderHistoryList, renderHistoryUsage, renderReplay, searchHistory, summarizeSession, type HistoryCommand, type HistoryEntry } from "./chat-history";

type Paint = (text: string) => string;

export type HistoryContext = {
  stateHistory: Pick<CliStateHistory, "sessions" | "search" | "refresh" | "status">;
  listSessions(limit: number): Promise<Array<{ id: string }>>;
  loadSession(id: string): Promise<SessionRecord | null | undefined>;
  currentSessionId: string | undefined;
  /** The interactive session picker; omitted when nobody is at the keyboard. */
  choose?: (items: readonly ChooserItem<string>[]) => Promise<string | undefined>;
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
      if (!id && context.choose && listed.length > 0) {
        id = await context.choose(listed.map((entry) => ({
          value: entry.id,
          label: entry.title || entry.id,
          hint: relativeTime(entry.updatedAt),
          description: `${entry.turns} turn${entry.turns === 1 ? "" : "s"}`,
        })));
      }
      if (!id) { write(paint.dim("  no session chosen\n")); return; }
      const record = await context.loadSession(id);
      if (!record) { write(paint.yellow(`  No session ${id}.\n`)); return; }
      await context.resume(record);
      write(`${renderReplay(record, style, { turns: 2 })}\n`);
      write(paint.green(`  resumed ${record.id}\n`));
      return;
    }
  }
}
