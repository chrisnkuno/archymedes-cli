/**
 * "Continue your last chat?" — the way back to a normal conversation, offered without being asked.
 *
 * Every session is saved, but a saved session nobody can find again might as well not be. So when
 * Archymedes starts in a folder that had a chat recently, it says so in one quiet line and makes
 * the cheapest possible key — Enter on the empty prompt — mean "yes, that one". Anything typed
 * instead is a new request and starts fresh, so the offer never stands between someone and their
 * first message.
 *
 * `ARCHYMEDES_RESUME` decides it: `ask` (the default) offers, `always` continues without asking,
 * `never` keeps every start fresh.
 */
import type { CliStateHistory } from "../session/state-history";

export type ResumePreference = "ask" | "always" | "never";

export function resumePreference(environment: Record<string, string | undefined>): ResumePreference {
  const value = environment.ARCHYMEDES_RESUME?.trim().toLowerCase();
  return value === "always" || value === "never" ? value : "ask";
}

/** How recent a chat must be for the offer to be worth a line: a week. */
export const RECENT_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export type RecentSession = { id: string; title: string; updatedAt: number };

/**
 * The newest session in this folder, if it was touched within the window.
 *
 * Prefers the native index (cheap) and falls back to the session files, the same order `/history`
 * uses. Any failure is "no recent session": an offer is a convenience and must never stop a start.
 */
export async function findRecentSession(options: {
  stateHistory: Pick<CliStateHistory, "sessions">;
  listSessions: (limit: number) => Promise<Array<{ id: string; title?: string; updatedAt?: number }>>;
  /**
   * Whether this project owns the session — `loadSession`, which refuses a record whose recorded
   * root is not this one. Index rows are a cache and can outlive or out-reach their files; only a
   * chat that loads here is offered, so another project's chat never is.
   */
  owns?: (id: string) => Promise<boolean>;
  now?: number;
  maxAgeMs?: number;
}): Promise<RecentSession | undefined> {
  try {
    const indexed = await options.stateHistory.sessions(5);
    const candidates = indexed && indexed.length > 0
      ? indexed.map((session) => ({ id: session.sessionId, title: session.title ?? "", updatedAt: session.updatedAt ?? 0 }))
      : (await options.listSessions(5)).map((session) => ({ id: session.id, title: session.title ?? "", updatedAt: session.updatedAt ?? 0 }));
    let newest: RecentSession | undefined;
    for (const candidate of candidates) {
      if (!options.owns || await options.owns(candidate.id)) { newest = candidate; break; }
    }
    if (!newest) return undefined;
    const age = (options.now ?? Date.now()) - newest.updatedAt;
    return age <= (options.maxAgeMs ?? RECENT_SESSION_MS) ? newest : undefined;
  } catch {
    return undefined;
  }
}

/** The one line under the banner. Titled, so "which chat?" is answered before anyone asks. */
export function resumeOfferLine(session: RecentSession, glyphs: { middot: string }, relative: (time: number) => string): string {
  const title = session.title.trim().replace(/\s+/g, " ");
  const shown = title.length > 48 ? `${title.slice(0, 47)}…` : title;
  return `Continue your last chat${shown ? ` "${shown}"` : ""} (${relative(session.updatedAt)})? Enter = yes ${glyphs.middot} type to start fresh`;
}
