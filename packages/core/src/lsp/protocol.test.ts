import { describe, expect, it } from "vitest";
import {
  appendLspFrame as appendLspFrameBytes,
  encodeLspMessage,
  isJsonRpcNotification,
  isJsonRpcResponse,
} from "./protocol";

/** The frame parser works on bytes; these tests read more easily as text. */
function appendLspFrame(text: string): { messages: unknown[]; rest: string } {
  const { messages, rest } = appendLspFrameBytes(Buffer.from(text, "utf8"));
  return { messages, rest: rest.toString("utf8") };
}

describe("encodeLspMessage", () => {
  it("frames a message with its byte length and a blank line", () => {
    const frame = encodeLspMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(frame).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  });

  it("counts bytes, not characters, so non-ASCII bodies are not cut short", () => {
    const message = { method: "textDocument/publishDiagnostics", params: { uri: "file:///café.ts", diagnostics: [] } };
    const frame = encodeLspMessage(message);
    const body = JSON.stringify(message);
    expect(frame).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    expect(frame.length).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`.length + body.length);
  });
});

describe("appendLspFrame", () => {
  it("extracts one complete frame and keeps the rest for later", () => {
    const frame = encodeLspMessage({ jsonrpc: "2.0", id: 7, result: null });
    const { messages, rest } = appendLspFrame(frame + "partial");
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 7, result: null }]);
    expect(rest).toBe("partial");
  });

  it("extracts several frames from one buffer in order", () => {
    const first = encodeLspMessage({ jsonrpc: "2.0", id: 1, result: "a" });
    const second = encodeLspMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a.ts", diagnostics: [] } });
    const { messages, rest } = appendLspFrame(first + second);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: "a" });
    expect((messages[1] as { method: string }).method).toBe("textDocument/publishDiagnostics");
    expect(rest).toBe("");
  });

  it("waits for a body that has not fully arrived", () => {
    const frame = encodeLspMessage({ jsonrpc: "2.0", id: 2, result: { nested: true } });
    const { messages, rest } = appendLspFrame(frame.slice(0, frame.length - 10));
    expect(messages).toEqual([]);
    expect(rest).toBe(frame.slice(0, frame.length - 10));
  });

  it("completes a frame split across two calls, as a pipe delivers them", () => {
    const frame = encodeLspMessage({ jsonrpc: "2.0", id: 3, result: [1, 2, 3] });
    const cut = Math.floor(frame.length / 2);
    const first = appendLspFrame(frame.slice(0, cut));
    expect(first.messages).toEqual([]);
    const second = appendLspFrame(first.rest + frame.slice(cut));
    expect(second.messages).toEqual([{ jsonrpc: "2.0", id: 3, result: [1, 2, 3] }]);
    expect(second.rest).toBe("");
  });

  it("skips a header block with no Content-Length instead of stalling on it", () => {
    const noise = "X-Noise: whatever\r\n\r\n";
    const frame = encodeLspMessage({ jsonrpc: "2.0", id: 4, result: null });
    const { messages, rest } = appendLspFrame(noise + frame);
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 4, result: null }]);
    expect(rest).toBe("");
  });

  it("skips a body that is not JSON and keeps parsing after it", () => {
    const broken = "Content-Length: 5\r\n\r\nnot-j";
    const frame = encodeLspMessage({ jsonrpc: "2.0", id: 5, result: null });
    const { messages, rest } = appendLspFrame(broken + frame);
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 5, result: null }]);
    expect(rest).toBe("");
  });

  it("cuts a non-ASCII body by bytes, so the frame after it still parses", () => {
    const first = encodeLspMessage({ jsonrpc: "2.0", id: 6, result: "café — naïve" });
    const second = encodeLspMessage({ jsonrpc: "2.0", id: 7, result: null });
    const { messages, rest } = appendLspFrame(first + second);
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 6, result: "café — naïve" }, { jsonrpc: "2.0", id: 7, result: null }]);
    expect(rest).toBe("");
  });

  it("reads a body containing escaped newlines as one frame", () => {
    const message = { method: "textDocument/publishDiagnostics", params: { uri: "file:///a.ts", diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "line one\nline two" }] } };
    const { messages, rest } = appendLspFrame(encodeLspMessage(message));
    expect(messages).toEqual([message]);
    expect(rest).toBe("");
  });
});

describe("message guards", () => {
  it("recognises a response by its numeric id", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 9, result: null })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 9, error: { code: -32601, message: "no" } })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics" })).toBe(false);
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: "9", result: null })).toBe(false);
    expect(isJsonRpcResponse(null)).toBe(false);
    // A request from the server has an id too, and must not be mistaken for an answer to ours.
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 9, method: "workspace/configuration" })).toBe(false);
  });

  it("recognises a notification by its method and absence of an id", () => {
    expect(isJsonRpcNotification({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {} })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBe(false);
    expect(isJsonRpcNotification({ jsonrpc: "2.0" })).toBe(false);
    expect(isJsonRpcNotification("textDocument/publishDiagnostics")).toBe(false);
  });
});
