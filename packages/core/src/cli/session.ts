import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentMessagePromptParts, type AgentMessage } from "../agent-runtime";
import { approximateInputTokens } from "../model-cost";
import { mergeRoutingReceipts, type RoutingReceipt } from "../providers/routing-receipt";
import type { ArchymedesMode } from "./permissions";

/**
 * Session persistence and context compaction.
 *
 * A terminal session that forgets everything when the process exits is a demo. Sessions are stored
 * as a plain JSON message log under `.archymedes/sessions`, which is deliberately the same shape the
 * runtime already passes around: resuming is reading the file back, not reconstructing state from
 * a summary of it.
 */

export type SessionRecord = {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  /** Optimistic concurrency token. A stale writer is rejected instead of losing a newer turn. */
  revision: number;
  id: string;
  createdAt: number;
  updatedAt: number;
  root: string;
  title: string;
  messages: AgentMessage[];
  /** Permission posture to restore on resume; absent on sessions written before this field. */
  mode?: ArchymedesMode;
  /** Explicit model access choice; never credentials or endpoints. */
  modelSelection?: { provider: string; model: string };
  /** Durable-memory entries already present in this transcript, so resume does not bill them twice. */
  recalledMemoryKeys?: string[];
  /** Standing tool approvals, so a resumed session does not re-ask what was already decided. */
  approvals: Record<string, "allow" | "deny">;
  totalRwf: number;
  /** Normalized hosted calls, retained across resume independently of transcript compaction. */
  routingReceipts?: RoutingReceipt[];
  /** SHA-256 over the canonical record without this field. */
  integrity?: string;
  /** Recovery batch already incorporated atomically into this snapshot. */
  hostedRecoveryBatchId?: string;
};

export const SESSION_SCHEMA_VERSION = 2 as const;

export function sessionDirectory(root: string): string {
  return path.join(root, ".archymedes", "sessions");
}

export function newSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === "." || id === "..") {
    throw new Error("Session id contains unsafe characters");
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return null;
}

function integrityFor(record: Omit<SessionRecord, "integrity">): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(record))).digest("hex");
}

async function acquireSessionLock(lockFile: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      return async () => { await fs.unlink(lockFile).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockFile).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.unlink(lockFile).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Session is being updated by another Archymedes process");
}

/** Atomic, checksummed and conflict-aware: an interrupted write never replaces the last snapshot. */
export async function saveSession(record: SessionRecord): Promise<string> {
  assertSessionId(record.id);
  const directory = sessionDirectory(record.root);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${record.id}.json`);
  const lockFile = `${file}.lock`;
  const release = await acquireSessionLock(lockFile);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fileExists = await fs.stat(file).then(() => true).catch(() => false);
    // The snapshot alone answers the revision question; replaying the journal here would be wasted work.
    const current = (await loadSnapshot(record.root, record.id))?.record;
    if (fileExists && !current) throw new Error("Existing session is corrupt or incompatible; refusing to overwrite it");
    if (current && current.revision !== record.revision) {
      throw new Error(`Session revision conflict: expected ${record.revision}, found ${current.revision}`);
    }
    const withoutIntegrity: Omit<SessionRecord, "integrity"> = {
      ...record,
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: record.revision + 1,
      updatedAt: Date.now(),
    };
    delete (withoutIntegrity as Partial<SessionRecord>).integrity;
    const next: SessionRecord = { ...withoutIntegrity, integrity: integrityFor(withoutIntegrity) };
    const handle = await fs.open(temporary, "wx", 0o600);
    // Compact JSON: the snapshot is a machine file, and indentation was ~30% of its bytes.
    const serialized = `${JSON.stringify(next)}\n`;
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const directoryHandle = await fs.open(directory, "r").catch(() => null);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    }
    // The snapshot now contains everything the journal held. Removing it is cleanup, not
    // correctness: lines for the old revision are ignored by `loadSession` either way.
    const journalRemoved = await fs.rm(sessionJournalPath(record.root, record.id), { force: true }).then(() => true, () => false);
    durableStates.set(stateKey(record.root, record.id), {
      revision: next.revision,
      messageCount: next.messages.length,
      lastFingerprint: messageFingerprint(next.messages.at(-1)),
      seq: 0,
      journalBytes: 0,
      snapshotBytes: Buffer.byteLength(serialized, "utf8"),
      ...(journalRemoved ? {} : { truncateTo: 0 }),
    });
    Object.assign(record, next);
    return file;
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
    await release();
  }
}

/**
 * The per-step journal: between full snapshots, each completed tool step appends one line.
 *
 * Rewriting the whole snapshot after every tool step made a session's persistence O(n²) in its
 * length — step 200 of a long session re-serialized, re-hashed, fsynced and re-read (for the
 * conflict check) everything steps 1–199 had already written. A step now appends only the
 * messages it added, and a full snapshot is written at turn end (and every
 * `JOURNAL_COMPACT_EVERY` steps, or when the journal grows past the snapshot's size), which then
 * empties the journal.
 *
 * Each line names the snapshot revision it extends (`base`) and its position (`seq`), and carries
 * a SHA-256 over itself. `loadSession` applies the lines that extend the snapshot it read, in
 * order, and stops at the first line that is torn, corrupt, out of sequence or for another
 * revision: a crash mid-append loses at most that one step, never the session.
 */
type JournalEntry = {
  base: number;
  seq: number;
  /** Index in `messages` where `append` begins (the count already durable before this step). */
  from: number;
  append: AgentMessage[];
  title: string;
  updatedAt: number;
  hash?: string;
};

const JOURNAL_COMPACT_EVERY = 64;

export function sessionJournalPath(root: string, id: string): string {
  assertSessionId(id);
  return path.join(sessionDirectory(root), `${id}.steps.jsonl`);
}

function journalEntryHash(entry: Omit<JournalEntry, "hash">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

function messageFingerprint(message: AgentMessage | undefined): string {
  return message === undefined ? "" : createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

/** What is durable on disk for one session file, as this process last wrote or read it. */
type DurableState = {
  revision: number;
  messageCount: number;
  /** Fingerprint of the last durable message, to detect a transcript rewritten rather than extended. */
  lastFingerprint: string;
  seq: number;
  journalBytes: number;
  snapshotBytes: number;
  /**
   * When the journal on disk holds bytes past its last valid entry (a torn line from a crash, or
   * stale lines a failed cleanup left), the length to cut it back to before the next append.
   * Otherwise a new line would land after the garbage, and the reader stops at the garbage.
   */
  truncateTo?: number;
};

const durableStates = new Map<string, DurableState>();
const journalQueues = new Map<string, Promise<unknown>>();

function stateKey(root: string, id: string): string {
  const key = path.resolve(root, id);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

/**
 * Persists one completed step cheaply: appends the messages added since the last durable write.
 *
 * Only `messages`, `title` and `updatedAt` travel in the journal — the fields a mid-turn step
 * changes. Anything else (approvals, spend, receipts) is persisted by the full `saveSession` at
 * turn end. Falls back to a full `saveSession` when there is no durable baseline in this process
 * yet, when the transcript was rewritten instead of extended, or when it is time to compact.
 */
export async function appendSessionStep(record: SessionRecord): Promise<void> {
  assertSessionId(record.id);
  const key = stateKey(record.root, record.id);
  const previous = journalQueues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => appendSessionStepNow(record, key));
  journalQueues.set(key, operation);
  try {
    await operation;
  } finally {
    if (journalQueues.get(key) === operation) journalQueues.delete(key);
  }
}

async function appendSessionStepNow(record: SessionRecord, key: string): Promise<void> {
  const state = durableStates.get(key);
  const extendsDurable = state
    && state.revision === record.revision
    && record.messages.length >= state.messageCount
    && messageFingerprint(record.messages[state.messageCount - 1]) === state.lastFingerprint;
  if (!state || !extendsDurable || state.seq >= JOURNAL_COMPACT_EVERY || state.journalBytes > Math.max(256 * 1024, state.snapshotBytes)) {
    await saveSession(record);
    return;
  }
  const file = sessionJournalPath(record.root, record.id);
  if (state.truncateTo !== undefined) {
    await fs.truncate(file, state.truncateTo).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    state.journalBytes = state.truncateTo;
    state.truncateTo = undefined;
  }
  const withoutHash: Omit<JournalEntry, "hash"> = {
    base: state.revision,
    seq: state.seq + 1,
    from: state.messageCount,
    append: record.messages.slice(state.messageCount),
    title: record.title,
    updatedAt: record.updatedAt,
  };
  const line = `${JSON.stringify({ ...withoutHash, hash: journalEntryHash(withoutHash) })}\n`;
  const handle = await fs.open(file, "a", 0o600);
  try {
    await handle.write(line);
    await handle.datasync();
  } finally {
    await handle.close();
  }
  state.seq += 1;
  state.journalBytes += Buffer.byteLength(line, "utf8");
  state.messageCount = record.messages.length;
  state.lastFingerprint = messageFingerprint(record.messages.at(-1));
}

/** Snapshot-only read: what `saveSession`'s conflict check needs, without replaying the journal. */
async function loadSnapshot(root: string, id: string): Promise<{ record: SessionRecord; bytes: number } | null> {
  try {
    assertSessionId(id);
    const text = await fs.readFile(path.join(sessionDirectory(root), `${id}.json`), "utf8");
    const record = await parseSnapshot(text, id, root);
    return record ? { record, bytes: Buffer.byteLength(text, "utf8") } : null;
  } catch {
    return null;
  }
}

/**
 * The journal entries that extend snapshot revision `base`, in order, and the byte length of that
 * valid prefix. Leading lines for an older revision (left when a compaction could not delete the
 * journal) are skipped; after the first matching line, anything torn, corrupt or out of sequence
 * ends the read.
 */
async function readJournal(root: string, id: string, base: number): Promise<{ entries: JournalEntry[]; bytes: number; validBytes: number }> {
  let text: string;
  try {
    text = await fs.readFile(sessionJournalPath(root, id), "utf8");
  } catch {
    return { entries: [], bytes: 0, validBytes: 0 };
  }
  const entries: JournalEntry[] = [];
  let offset = 0;
  let validBytes = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) break; // torn final line: the append that wrote it never completed
    const line = text.slice(offset, newline);
    offset = newline + 1;
    let entry: JournalEntry;
    try { entry = JSON.parse(line) as JournalEntry; } catch { break; }
    const { hash, ...withoutHash } = entry;
    if (hash !== journalEntryHash(withoutHash) || !Array.isArray(entry.append) || !Number.isSafeInteger(entry.from) || entry.from < 0) break;
    if (entries.length === 0 && entry.base < base) continue;
    if (entry.base !== base || entry.seq !== entries.length + 1) break;
    entries.push(entry);
    validBytes = Buffer.byteLength(text.slice(0, offset), "utf8");
  }
  return { entries, bytes: Buffer.byteLength(text, "utf8"), validBytes };
}

export async function loadSession(root: string, id: string): Promise<SessionRecord | null> {
  const key = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? stateKey(root, id) : undefined;
  // An append in flight would make the journal read below race its own writer.
  if (key) await journalQueues.get(key)?.catch(() => undefined);
  const snapshot = await loadSnapshot(root, id);
  if (!snapshot) return null;
  let record = snapshot.record;
  const journal = await readJournal(root, id, record.revision);
  let applied = 0;
  for (const entry of journal.entries) {
    if (entry.from > record.messages.length) break;
    record = { ...record, messages: [...record.messages.slice(0, entry.from), ...entry.append], title: entry.title, updatedAt: entry.updatedAt };
    applied += 1;
  }
  // The snapshot's checksum covers the snapshot, not the replayed record; the next full save recomputes it.
  if (applied > 0) delete record.integrity;
  const known = durableStates.get(key!);
  // Re-seeded whenever the disk disagrees with what this process believes it wrote (another
  // writer, or a crash that left a torn line), so the next append starts from the disk's truth.
  if (!known || known.revision !== record.revision || known.seq !== applied || known.journalBytes !== journal.bytes || known.truncateTo !== undefined) {
    const validBytes = applied === journal.entries.length ? journal.validBytes : undefined;
    durableStates.set(key!, {
      revision: record.revision,
      messageCount: record.messages.length,
      lastFingerprint: messageFingerprint(record.messages.at(-1)),
      // An entry that could not be applied makes everything from it on unusable: compact instead.
      seq: validBytes === undefined ? JOURNAL_COMPACT_EVERY : applied,
      journalBytes: journal.bytes,
      snapshotBytes: snapshot.bytes,
      ...(validBytes !== undefined && validBytes !== journal.bytes ? { truncateTo: validBytes } : {}),
    });
  }
  return record;
}

async function parseSnapshot(text: string, id: string, root: string): Promise<SessionRecord | null> {
  try {
    const parsed = JSON.parse(text) as Partial<SessionRecord>;
    if (!parsed || typeof parsed !== "object" || parsed.id !== id || typeof parsed.root !== "string") return null;
    const [storedRoot, requestedRoot] = await Promise.all(
      [parsed.root, root].map(async (candidate) => fs.realpath(path.resolve(candidate)).catch(() => path.resolve(candidate))),
    );
    const rootsMatch = process.platform === "win32"
      ? storedRoot.toLocaleLowerCase("en-US") === requestedRoot.toLocaleLowerCase("en-US")
      : storedRoot === requestedRoot;
    if (!rootsMatch) return null;
    if (!Array.isArray(parsed.messages) || typeof parsed.approvals !== "object" || parsed.approvals === null) return null;
    if (!Number.isSafeInteger(parsed.totalRwf) || (parsed.totalRwf ?? -1) < 0) return null;
    if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > SESSION_SCHEMA_VERSION) return null;
    if (parsed.integrity) {
      const { integrity, ...withoutIntegrity } = parsed as SessionRecord;
      if (integrity !== integrityFor(withoutIntegrity)) return null;
    }
    return {
      ...(parsed as SessionRecord),
      routingReceipts: mergeRoutingReceipts(parsed.routingReceipts),
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: Number.isSafeInteger(parsed.revision) && (parsed.revision ?? -1) >= 0 ? parsed.revision! : 0,
    };
  } catch {
    return null;
  }
}

export async function listSessions(root: string, limit = 20): Promise<Array<Pick<SessionRecord, "id" | "title" | "updatedAt">>> {
  try {
    const files = await fs.readdir(sessionDirectory(root));
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            const record = await loadSession(root, file.slice(0, -5));
            if (!record) return null;
            return { id: record.id, title: record.title, updatedAt: record.updatedAt };
          } catch {
            return null;
          }
        }),
    );
    return records
      .filter((record): record is NonNullable<typeof record> => record !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** First line of the opening request, which is what a person recognises a session by. */
export function titleFromObjective(objective: string): string {
  return objective.trim().split("\n")[0].slice(0, 72) || "Untitled session";
}

export function estimateMessageTokens(messages: readonly AgentMessage[]): number {
  /**
   * The expected figure, not the pessimistic one.
   *
   * `maximumInputTokens` is `max(expected + 256, utf8Bytes + 1024)`, and for any real transcript
   * the *byte* term wins — it is roughly three times the token count. Comparing that against the
   * context limit meant Archymedes believed it was full at about 28% of a 200K window, and 5.6% of a 1M
   * one: it compacted, paid a summarization call, discarded detail, and rebuilt its whole prompt
   * cache, five times more often than it had any reason to. Measured on real source text, the
   * first `required` fired at 56,216 actual tokens against a 184,000-token allowance.
   *
   * The pessimistic reading was defensible when the alternative was losing a turn to a
   * context-length error, but it was the wrong tool for that job: the reserve for the reply is
   * already subtracted by the caller, and 0.9 of what remains is the safety margin.
   *
   * Tool-call arguments are counted too. They are part of an assistant message on the wire and
   * were invisible here, so a transcript of many tool calls read as smaller than it was — an error
   * in the opposite direction, hidden behind the first one.
   */
  const parts: string[] = [];
  for (const message of messages) parts.push(...agentMessagePromptParts(message));
  return approximateInputTokens(parts).expectedInputTokens;
}

export type CompactionPlan = {
  /** Messages to hand to the summarizer. */
  toSummarize: AgentMessage[];
  /** Messages kept verbatim after the summary. */
  toKeep: AgentMessage[];
};

/**
 * How badly a transcript needs compacting, which is not the same question as whether it may be.
 *
 * `advisable` means the conversation has grown past the point where compacting is cheap and safe;
 * `required` means the next turn will not fit and compacting is no longer optional. The split
 * exists because the right moment to forget is a property of the *work*, not of the buffer: a
 * numeric threshold alone forces a summary in the middle of a half-finished edit, where the detail
 * being discarded is exactly the detail the next tool call needs. Splitting the decision lets the
 * caller compact early when the work is at a boundary, and only override that when it must.
 */
export type CompactionUrgency = "none" | "advisable" | "required";

/** Where compacting is cheap because the work has concluded, versus mid-task where it is not. */
export type CompactionBoundary = "safe" | "mid-task";

const ADVISABLE_SHARE = 0.7;
const REQUIRED_SHARE = 0.9;

export function compactionUrgency(
  messages: readonly AgentMessage[],
  options: { contextLimit: number; outputBudget: number },
): CompactionUrgency {
  const usable = Math.max(options.contextLimit - options.outputBudget, 0);
  const used = estimateMessageTokens(messages);
  if (used > usable * REQUIRED_SHARE) return "required";
  if (used > usable * ADVISABLE_SHARE) return "advisable";
  return "none";
}

/**
 * Whether the transcript is at a point where forgetting is safe.
 *
 * Two conditions, both structural rather than guessed. The transcript must end with a plain
 * assistant message — a turn that actually concluded, rather than one suspended between a tool
 * call and its result, where summarizing would strand the call. And nothing may be marked
 * in progress on the agent's own plan: an item the agent believes it is halfway through is a
 * promise that the details behind it still matter.
 */
export function atSafeBoundary(messages: readonly AgentMessage[], options: { workInProgress?: boolean } = {}): boolean {
  if (options.workInProgress) return false;
  const last = messages.at(-1);
  return last !== undefined && last.role === "assistant" && !("toolCalls" in last);
}

/**
 * Decides what to compact when a conversation approaches the model's context limit.
 *
 * OpenCode's threshold — summarize at 90% of what is left after reserving the output budget — is
 * the ceiling used here, but not the only trigger: past 70% the transcript is compacted as soon as
 * the work reaches a boundary, so the summary is written where there is a clean thing to say
 * rather than wherever the buffer happened to fill. Two rules then shape the split, and both exist
 * to avoid breaking the transcript: the system and opening messages are always kept, and the tail
 * is cut at a boundary that never separates an assistant's tool calls from their results, since a
 * tool result whose call has been summarized away is an API error rather than a smaller context.
 */
export function planCompaction(
  messages: readonly AgentMessage[],
  options: { contextLimit: number; outputBudget: number; keepRecent?: number; boundary?: CompactionBoundary },
): CompactionPlan | null {
  const urgency = compactionUrgency(messages, options);
  if (urgency === "none") return null;
  if (urgency === "advisable" && (options.boundary ?? "mid-task") !== "safe") return null;

  const keepRecent = options.keepRecent ?? recentToKeep(messages.slice(messages[0]?.role === "system" ? 2 : 1), options);
  // The system prompt and the original request are what the whole session means; they never go.
  const head = messages.slice(0, messages[0]?.role === "system" ? 2 : 1);
  const rest = messages.slice(head.length);
  if (rest.length <= keepRecent) return null;

  let cut = rest.length - keepRecent;
  // Walk the cut backwards until the kept tail does not begin with orphaned tool results.
  while (cut > 0 && rest[cut]?.role === "tool") cut -= 1;
  if (cut <= 0) return null;

  return { toSummarize: [...head, ...rest.slice(0, cut)], toKeep: rest.slice(cut) };
}

/**
 * The fewest recent messages worth keeping verbatim, measured in tokens rather than counted.
 *
 * "Keep the last six messages" treats a two-line acknowledgement and a 40,000-character test log as
 * the same size. Six of the latter is around 60,000 tokens carried past a compaction that happened
 * *because* the transcript was too large; six of the former is 300 tokens, and throws away context
 * the next turn plainly needed. Neither is what the number was trying to express.
 *
 * What it was trying to express is: leave enough of the recent conversation intact that the agent
 * can continue without re-reading the summary for details it just had. That is a size, so it is
 * measured as one — a fifth of the usable window — with a floor of one complete exchange, because a
 * kept tail of nothing is a compaction the agent cannot continue from at all.
 */
const KEEP_RECENT_SHARE = 0.2;
const MINIMUM_KEPT_MESSAGES = 2;

function recentToKeep(recent: readonly AgentMessage[], options: { contextLimit: number; outputBudget: number }): number {
  const budget = Math.max(0, options.contextLimit - options.outputBudget) * KEEP_RECENT_SHARE;
  let spent = 0;
  let kept = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const cost = estimateMessageTokens([recent[index]]);
    if (kept >= MINIMUM_KEPT_MESSAGES && spent + cost > budget) break;
    spent += cost;
    kept += 1;
  }
  return Math.min(recent.length, Math.max(MINIMUM_KEPT_MESSAGES, kept));
}

/** The instruction used to compact a conversation, kept next to the policy that triggers it. */
export const COMPACTION_INSTRUCTION = [
  "Summarize the conversation so far so that work can continue without the full transcript.",
  "Include: what the user asked for, what has been done and verified, the exact files and symbols involved, decisions made and why, and what remains.",
  "Preserve concrete details — paths, function names, commands run and their results, error messages. Drop pleasantries and superseded attempts.",
  "Reproduce every standing instruction, prohibition and constraint the user gave, verbatim and in full, however long ago it was said — these are the one thing that must never be shortened or paraphrased away.",
  "Write it as notes to your future self, not as a report to the user.",
].join(" ");

/**
 * The governing facts of a session, which a summary is not allowed to be the only record of.
 *
 * Summarization is lossy by design, and what it loses first is the boring part: the permission
 * mode, which exact actions the user has already approved or refused, what the session is
 * permitted to spend, what the original request actually said. Every one of those is a constraint
 * on what the agent may *do*, and a constraint that survives only as a sentence in a summary is a
 * constraint that quietly stops existing three compactions later — the failure mode is silent,
 * because nothing errors when a rule is simply no longer mentioned.
 *
 * So they are never summarized. They are re-derived from live state at every compaction and
 * re-stated verbatim, which means the block cannot drift from the ledger it describes: it is a
 * rendering of the ledger, not a memory of it.
 */
export type StandingConstraints = {
  mode: string;
  /** The request that opened the session, in full. */
  objective: string;
  /** Decisions the user has already made about specific actions. */
  approvals: Record<string, "allow" | "deny">;
  /** Items the agent's own plan still has open. */
  openTodos: string[];
  /** What is left to spend, already formatted for a person. */
  budgetRemaining?: string;
};

export const STANDING_CONSTRAINTS_HEADING = "[Standing constraints — still in force, not a summary]";

export function standingConstraintsBlock(constraints: StandingConstraints): string {
  const allowed = Object.entries(constraints.approvals).filter(([, decision]) => decision === "allow").map(([key]) => key);
  const denied = Object.entries(constraints.approvals).filter(([, decision]) => decision === "deny").map(([key]) => key);
  return [
    STANDING_CONSTRAINTS_HEADING,
    `Permission mode: ${constraints.mode}.`,
    `Original request: ${constraints.objective.trim()}`,
    allowed.length > 0 ? `Actions the user has standing-approved: ${allowed.join(", ")}.` : "No action has standing approval; every effectful call is asked for.",
    ...(denied.length > 0 ? [`Actions the user has refused — do not propose them again: ${denied.join(", ")}.`] : []),
    ...(constraints.openTodos.length > 0 ? [`Still open: ${constraints.openTodos.join("; ")}.`] : []),
    ...(constraints.budgetRemaining ? [`Remaining approved spend: ${constraints.budgetRemaining}.`] : []),
  ].join("\n");
}

/**
 * The transcript after compaction: the system message, the constraints, the summary, the tail.
 *
 * Constraints first and summary second, deliberately. The summary is the part the model reasons
 * *from*; the constraints are the part it must reason *within*, and putting them ahead of the
 * narrative keeps them from reading as one more historical detail that happened to be mentioned.
 */
export function buildCompactedMessages(summary: string, plan: CompactionPlan, standing?: StandingConstraints): AgentMessage[] {
  const system = plan.toSummarize[0]?.role === "system" ? [plan.toSummarize[0]] : [];
  return [
    ...system,
    ...(standing ? [{ role: "user" as const, content: standingConstraintsBlock(standing) }] : []),
    { role: "user" as const, content: `[Earlier conversation, summarized]\n\n${summary.trim()}` },
    ...plan.toKeep,
  ];
}
