/**
 * A tiny, real language server over stdio — Content-Length framed JSON-RPC 2.0, exactly what
 * `LspClient` speaks. Not a mock of the protocol: this is the actual message shape a real
 * server sends, run as a real subprocess, so a bug in framing or field names shows up the same
 * way it would against a genuine server.
 *
 * Frames are read by byte count, as the protocol defines them: a client writes no newline after
 * a body, so a line-based reader would never see where one message ends.
 *
 * Optional arguments: argv[2] delays the `initialize` answer by that many milliseconds (a
 * slow-starting server); argv[3] is a file a line is appended to on every start, so a test can
 * count spawns. `didChange` publishes one error per line containing "ERR", tagged with the
 * document version, so a test can tell which text a publication describes.
 */
export const FAKE_SERVER_SCRIPT = `
const initDelay = Number(process.argv[2] || 0);
if (process.argv[3]) require("fs").appendFileSync(process.argv[3], "start " + process.pid + "\\n");
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}
function handle(message) {
  if (message.method === "initialize") {
    if (initDelay > 0) { const id = message.id; setTimeout(() => send({ jsonrpc: "2.0", id, result: { capabilities: { textDocumentSync: 1 } } }), initDelay); return; }
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { hoverProvider: true, definitionProvider: true }, serverInfo: { name: "fake", version: "1" } } });
    return;
  }
  if (message.method === "initialized") return; // no response — it's a notification
  if (message.method === "textDocument/didOpen") {
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, diagnostics: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, severity: 1, source: "fake", message: "Cannot find name 'x'." },
      { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } }, severity: 2, message: "Unused expression" },
    ] } });
    return;
  }
  if (message.method === "textDocument/didChange") {
    const text = message.params.contentChanges[message.params.contentChanges.length - 1].text;
    const diagnostics = [];
    text.split("\\n").forEach((line, index) => {
      if (line.includes("ERR")) diagnostics.push({ range: { start: { line: index, character: 0 }, end: { line: index, character: line.length } }, severity: 1, source: "fake", message: "v" + message.params.textDocument.version + " " + line.trim() });
    });
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, version: message.params.textDocument.version, diagnostics } });
    return;
  }
  if (message.method === "textDocument/didClose" || message.method === "exit") return;
  if (message.method === "textDocument/hover") {
    send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "markdown", value: "const x: string" } } });
    return;
  }
  if (message.method === "textDocument/definition") {
    send({ jsonrpc: "2.0", id: message.id, result: [{ uri: "file:///src/other.ts", range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } } }] });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method: " + message.method } });
}
let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const separator = pending.indexOf("\\r\\n\\r\\n");
    if (separator === -1) return;
    const match = /content-length:\\s*(\\d+)/i.exec(pending.subarray(0, separator).toString("ascii"));
    const start = separator + 4;
    if (!match) { pending = pending.subarray(start); continue; }
    const length = Number(match[1]);
    if (pending.length < start + length) return;
    const body = pending.subarray(start, start + length).toString("utf8");
    pending = pending.subarray(start + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // A malformed body is ignored; the server keeps serving.
    }
  }
});
`;
