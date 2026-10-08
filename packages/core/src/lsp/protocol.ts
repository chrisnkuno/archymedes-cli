/**
 * The Language Server Protocol's wire format: JSON-RPC 2.0 messages framed by Content-Length.
 *
 * LSP chose header framing over the newline-delimited JSON-RPC that MCP uses, and the reason is
 * the payload: a diagnostic message or a hover result is arbitrary UTF-8 text that may contain
 * newlines, and a framing rule that cannot represent a literal newline inside the body forces
 * every sender to escape what the protocol did not ask it to escape. `Content-Length` in bytes
 * makes the body opaque — the reader takes exactly N bytes and hands them to the JSON parser,
 * whatever they contain.
 *
 * This module is the whole of the wire contract: the message types the features below need
 * (diagnostics, hover, definition, didOpen) plus the two framing functions. Nothing here spawns
 * a process or holds a connection — that is `client.ts`, and keeping the two apart means the
 * framing is testable against captured bytes rather than against a live server.
 */

/** 1 = Error, 2 = Warning, 3 = Information, 4 = Hint — the protocol's own numbering. */
export type LspDiagnosticSeverity = 1 | 2 | 3 | 4;

export type LspPosition = {
  /** Zero-based line number. */
  line: number;
  /** Zero-based UTF-16 code unit offset within the line. */
  character: number;
};

export type LspRange = { start: LspPosition; end: LspPosition };

export type LspLocation = { uri: string; range: LspRange };

export type LspDiagnostic = {
  range: LspRange;
  severity?: LspDiagnosticSeverity;
  code?: number | string;
  /** The tool that produced the diagnostic, e.g. `typescript` or `eslint`. */
  source?: string;
  message: string;
};

export type PublishDiagnosticsParams = {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
};

export type TextDocumentIdentifier = { uri: string };

export type DidOpenTextDocumentParams = {
  textDocument: {
    uri: string;
    languageId: string;
    version: number;
    text: string;
  };
};

export type HoverParams = {
  textDocument: TextDocumentIdentifier;
  position: LspPosition;
};

export type MarkupContent = { kind: "markdown" | "plaintext"; value: string };
export type MarkedString = string | { language: string; value: string };
export type HoverResult = { contents: MarkupContent | MarkedString | MarkedString[]; range?: LspRange };

export type DefinitionParams = HoverParams;
export type LocationOrLocations = LspLocation | LspLocation[];

export type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
export type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };

const HEADER_SEPARATOR = "\r\n\r\n";

/**
 * Frames one message for the wire: `Content-Length` in bytes, a blank line, the JSON body.
 *
 * The length is the byte length of the UTF-8 encoding, not the string length — a server that
 * counted characters would hand the client a body that ends mid-character the moment a message
 * contains anything non-ASCII, which is every message once paths or identifiers carry accents.
 */
export function encodeLspMessage(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

export type FrameResult = { messages: unknown[]; rest: Buffer };

/**
 * Extracts every complete frame from a buffer, returning what is left over.
 *
 * Called on each chunk the child's stdout emits, because a frame is not a chunk: TCP (and a
 * pipe) preserve byte order and nothing else, so one frame may arrive split across several
 * writes and one write may end with the start of the next frame. The leftover is held by the
 * caller and prepended to the next chunk.
 *
 * Works on bytes, not on a decoded string: `Content-Length` counts bytes, and a body cut by
 * character count ends in the wrong place as soon as it contains anything outside ASCII.
 *
 * A header block that carries no parseable Content-Length is skipped rather than fatal — a
 * server that writes something unexpected to stdout has not broken the protocol, and killing
 * the connection over it would turn a cosmetic server bug into a dead feature.
 */
export function appendLspFrame(buffer: Buffer): FrameResult {
  const messages: unknown[] = [];
  let rest = buffer;
  for (;;) {
    const separator = rest.indexOf(HEADER_SEPARATOR);
    if (separator === -1) break;
    const headerBlock = rest.subarray(0, separator).toString("ascii");
    const lengthHeader = headerBlock.split("\r\n").find((line) => /^content-length:/i.test(line));
    const length = lengthHeader === undefined ? NaN : Number(lengthHeader.slice(lengthHeader.indexOf(":") + 1).trim());
    const start = separator + HEADER_SEPARATOR.length;
    if (!Number.isInteger(length) || length < 0) {
      rest = rest.subarray(start);
      continue;
    }
    if (rest.length < start + length) break; // the body is still in flight; wait for more bytes
    const body = rest.subarray(start, start + length).toString("utf8");
    rest = rest.subarray(start + length);
    try {
      messages.push(JSON.parse(body));
    } catch {
      // A body that is not JSON is skipped, not fatal: one malformed frame must not take the
      // connection down with it, and the pending-request timeout is the backstop for a reply
      // that never comes.
    }
  }
  return { messages, rest };
}

/** A response carries an id to answer, either a result or an error, and no method of its own. */
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return typeof value === "object" && value !== null
    && "jsonrpc" in value && "id" in value && typeof (value as { id: unknown }).id === "number" && !("method" in value);
}

/** A request from the server to the client: a method to run and an id that expects an answer. */
export function isJsonRpcRequest(value: unknown): value is { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown } {
  return typeof value === "object" && value !== null && "jsonrpc" in value && "id" in value
    && typeof (value as { method?: unknown }).method === "string";
}

/** A notification carries a method and deliberately no id to answer. */
export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return typeof value === "object" && value !== null
    && "jsonrpc" in value && !("id" in value)
    && typeof (value as { method?: unknown }).method === "string";
}
