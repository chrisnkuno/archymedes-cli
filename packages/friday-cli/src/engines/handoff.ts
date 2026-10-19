import type { SessionRecord } from "@archymedes/core/cli/session";

/**
 * Context across engines. One Archymedes session can be run by Archymedes's own agent, by the
 * person's Claude Code, or by their Codex, switching between them with the transcript kept. The
 * native agent reads the transcript itself; an outside engine keeps its own conversation, so it is
 * told, as text, what was said while it was not there:
 *
 * - an engine that has never seen this session is told the whole conversation (newest kept within
 *   `MAX_PREFACE_CHARS`);
 * - an engine coming back to a session it ran before resumes its own conversation and is told only
 *   what was said since it last took part (`engineSeen`), so a Claude → Codex → Claude session does
 *   not lose the Codex turns.
 *
 * What is passed is what was said, not a summary and not tool state: the work itself is in the
 * files (T3 Code's portable handoffs make the same choice).
 */

/** How much of an earlier conversation an engine is told, at most. */
export const MAX_PREFACE_CHARS = 24_000;

/**
 * What was said before, for an engine that was not there: the text of each turn, newest kept.
 * Internal messages and tool output are left out.
 */
export function prefaceFrom(messages: SessionRecord["messages"]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.internal || (message.role !== "user" && message.role !== "assistant") || !message.content.trim()) continue;
    lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${message.content.trim()}`);
  }
  if (lines.length === 0) return "";
  let body = lines.join("\n\n");
  if (body.length > MAX_PREFACE_CHARS) body = `…\n${body.slice(body.length - MAX_PREFACE_CHARS)}`;
  return `<earlier_conversation note="This conversation began with another model. It is what was said, for context; the work it describes is in the files.">\n${body}\n</earlier_conversation>`;
}

/**
 * What an engine is told before its next prompt. `resumable` says it still has its own copy of the
 * conversation (Claude's session, Codex's thread): it is then told only what came after the point
 * it last saw. A record from before `engineSeen` existed counts as seen in full.
 */
export function handoffPreface(record: SessionRecord, engine: string, resumable: boolean): string {
  if (!resumable) return prefaceFrom(record.messages);
  const seen = record.engineSeen?.[engine] ?? record.messages.length;
  const missed = record.messages.slice(Math.min(Math.max(seen, 0), record.messages.length));
  if (!prefaceFrom(missed)) return "";
  return prefaceFrom(missed).replace(
    'note="This conversation began with another model.',
    'note="While you were away, this conversation went on with another model.',
  );
}

/** Marks the transcript as seen by `engine` up to its end: what it is told next starts here. */
export function markSeen(record: SessionRecord, engine: string): void {
  record.engineSeen = { ...record.engineSeen, [engine]: record.messages.length };
}
