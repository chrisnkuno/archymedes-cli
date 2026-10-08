/**
 * The diagnostics half of LSP: what a server publishes, and the collection a client keeps.
 *
 * A server pushes diagnostics — it is never asked for them. `textDocument/publishDiagnostics`
 * arrives unprompted after a file is opened or changed, and it *replaces* the diagnostics for
 * that document rather than adding to them: a server that re-analysed a file and now finds
 * nothing wrong publishes an empty array, and a collection that merged would keep showing
 * errors the server has already cleared. That replace-per-document semantics is the whole
 * reason this is a map keyed by URI and not a list.
 *
 * Parsing is strict about the shape and lenient about the extras: a server that adds fields
 * (tags, relatedInformation, data for code actions) is conformant, and dropping them here is
 * fine because nothing downstream reads them yet. A server that omits `message` or sends a
 * severity outside 1–4 is not conformant, and that is reported rather than guessed at.
 */

import type { LspDiagnostic, LspDiagnosticSeverity, LspPosition, LspRange, PublishDiagnosticsParams } from "./protocol";

export type SeverityName = "error" | "warning" | "information" | "hint";

/**
 * The protocol's severity number as the word every renderer and message uses.
 *
 * An omitted severity means "up to the client to interpret", and the interpretation chosen
 * here is the cautious one: an unmarked diagnostic is shown as an error. A linter that
 * publishes a bare informational note without a severity is rare; a server that accidentally
 * drops the field on something serious is not, and the failure mode of understating it is a
 * problem someone does not see.
 */
export function severityName(severity: LspDiagnosticSeverity | undefined): SeverityName {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "information";
    case 4: return "hint";
    default: return "error";
  }
}

/**
 * Validates an untyped `publishDiagnostics` payload into a `PublishDiagnosticsParams`.
 *
 * The params arrive from a process this code spawned and do not trust. Every field the
 * collection actually reads is checked; anything else is passed through or dropped. A payload
 * that fails validation throws — the caller records it as a protocol error against that
 * server rather than letting a half-parsed diagnostic reach the screen.
 */
export function parsePublishDiagnostics(params: unknown): PublishDiagnosticsParams {
  if (typeof params !== "object" || params === null) throw new Error("publishDiagnostics params must be an object");
  const candidate = params as Record<string, unknown>;
  if (typeof candidate.uri !== "string" || candidate.uri === "") throw new Error("publishDiagnostics params.uri must be a non-empty string");
  if (!Array.isArray(candidate.diagnostics)) throw new Error("publishDiagnostics params.diagnostics must be an array");
  return {
    uri: candidate.uri,
    ...(typeof candidate.version === "number" ? { version: candidate.version } : {}),
    diagnostics: candidate.diagnostics.map((raw, index) => parseDiagnostic(raw, index)),
  };
}

function parseDiagnostic(raw: unknown, index: number): LspDiagnostic {
  if (typeof raw !== "object" || raw === null) throw new Error(`diagnostics[${index}] must be an object`);
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.message !== "string" || candidate.message === "") {
    throw new Error(`diagnostics[${index}].message must be a non-empty string`);
  }
  const severity = candidate.severity;
  if (severity !== undefined && (typeof severity !== "number" || !Number.isInteger(severity) || severity < 1 || severity > 4)) {
    throw new Error(`diagnostics[${index}].severity must be an integer between 1 and 4`);
  }
  const code = candidate.code;
  if (code !== undefined && typeof code !== "number" && typeof code !== "string") {
    throw new Error(`diagnostics[${index}].code must be a number or a string`);
  }
  return {
    range: parseRange(candidate.range, `diagnostics[${index}].range`),
    ...(severity !== undefined ? { severity: severity as LspDiagnosticSeverity } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(typeof candidate.source === "string" ? { source: candidate.source } : {}),
    message: candidate.message,
  };
}

function parseRange(raw: unknown, label: string): LspRange {
  if (typeof raw !== "object" || raw === null) throw new Error(`${label} must be an object`);
  const candidate = raw as Record<string, unknown>;
  return {
    start: parsePosition(candidate.start, `${label}.start`),
    end: parsePosition(candidate.end, `${label}.end`),
  };
}

function parsePosition(raw: unknown, label: string): LspPosition {
  if (typeof raw !== "object" || raw === null) throw new Error(`${label} must be an object`);
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.line !== "number" || !Number.isInteger(candidate.line) || candidate.line < 0) {
    throw new Error(`${label}.line must be a non-negative integer`);
  }
  if (typeof candidate.character !== "number" || !Number.isInteger(candidate.character) || candidate.character < 0) {
    throw new Error(`${label}.character must be a non-negative integer`);
  }
  return { line: candidate.line, character: candidate.character };
}

export type DiagnosticCounts = {
  error: number;
  warning: number;
  information: number;
  hint: number;
  total: number;
};

export type UriDiagnostics = { uri: string; diagnostics: readonly LspDiagnostic[] };

/**
 * Every diagnostic the servers have published, keyed by document URI.
 *
 * Replace-per-document on publish (see the module header), sorted URIs for display, and a
 * severity tally computed on demand — the counts are read far more often than they change, and
 * caching them would mean finding every place a publish happens to invalidate the cache.
 */
export class DiagnosticsCollection {
  private readonly byUri = new Map<string, LspDiagnostic[]>();

  publish(params: PublishDiagnosticsParams): void {
    this.byUri.set(params.uri, params.diagnostics);
  }

  /** With no URI, clears everything — what a workspace-wide refresh wants. */
  clear(uri?: string): void {
    if (uri === undefined) this.byUri.clear();
    else this.byUri.delete(uri);
  }

  get(uri: string): readonly LspDiagnostic[] {
    return this.byUri.get(uri) ?? [];
  }

  uris(): string[] {
    return [...this.byUri.keys()].sort();
  }

  all(): UriDiagnostics[] {
    return this.uris().map((uri) => ({ uri, diagnostics: this.get(uri) }));
  }

  counts(): DiagnosticCounts {
    const counts: DiagnosticCounts = { error: 0, warning: 0, information: 0, hint: 0, total: 0 };
    for (const diagnostics of this.byUri.values()) {
      for (const diagnostic of diagnostics) {
        counts[severityName(diagnostic.severity)] += 1;
        counts.total += 1;
      }
    }
    return counts;
  }
}
