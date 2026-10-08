import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpMcpTransport } from "./http-transport";

let server: Server;
let baseUrl: string;

/**
 * A real HTTP server speaking MCP's Streamable HTTP protocol: it reads one JSON-RPC POST and answers
 * either with a single JSON body or with an event stream, per the test. Running it over an actual
 * socket on an ephemeral port means the test exercises the same fetch/parse path production uses —
 * content-type negotiation, SSE framing and session headers included — with no mock in between.
 */
function startServer(handler: (body: any, res: import("node:http").ServerResponse) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => handler(JSON.parse(raw), res));
    });
    // The port is new each time a test replaces the server, so the URL is set here, not once.
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      resolve();
    });
  });
}

function json(res: import("node:http").ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body);
}

function sse(res: import("node:http").ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) {
    if (event.event) res.write(`event: ${event.event}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }
  res.end();
}

beforeEach(async () => {
  // Default: answer every request with a JSON-RPC result naming the method back.
  await startServer((body, res) => {
    if (body.method === "initialize") {
      json(res, 200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }, { "Mcp-Session-Id": "session-1" });
      return;
    }
    json(res, 200, { jsonrpc: "2.0", id: body.id, result: { echoed: body.method } });
  });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("HttpMcpTransport", () => {
  it("answers a request with its result", async () => {
    const transport = new HttpMcpTransport({ id: "remote", url: baseUrl }, 5_000, () => {});
    try {
      await expect(transport.request("tools/list", {})).resolves.toMatchObject({ echoed: "tools/list" });
    } finally {
      transport.close();
    }
  });

  it("sends the session id the server issued on later requests", async () => {
    // The server issued `Mcp-Session-Id` on initialize; a client that does not echo it back gets
    // its second request rejected as an unknown session. This server enforces exactly that.
    await new Promise((resolve) => server.close(resolve));
    await startServer((body, res) => {
      if (body.method === "initialize") {
        json(res, 200, { jsonrpc: "2.0", id: body.id, result: {} }, { "Mcp-Session-Id": "session-9" });
        return;
      }
      if (req_session(res) !== "session-9") {
        json(res, 404, { error: "unknown session" });
        return;
      }
      json(res, 200, { jsonrpc: "2.0", id: body.id, result: { ok: true } });
    });
    const transport = new HttpMcpTransport({ id: "remote", url: baseUrl }, 5_000, () => {});
    try {
      await transport.request("initialize", {});
      await expect(transport.request("tools/list", {})).resolves.toMatchObject({ ok: true });
    } finally {
      transport.close();
    }
  });

  it("sends the configured headers with every request", async () => {
    await new Promise((resolve) => server.close(resolve));
    const seen: Array<string | undefined> = [];
    await startServer((body, res) => {
      seen.push(res.req.headers["authorization"]);
      json(res, 200, { jsonrpc: "2.0", id: body.id, result: {} });
    });
    const transport = new HttpMcpTransport({ id: "remote", url: baseUrl, headers: { Authorization: "Bearer tok" } }, 5_000, () => {});
    try {
      await transport.request("tools/list", {});
      expect(seen).toEqual(["Bearer tok"]);
    } finally {
      transport.close();
    }
  });

  it("parses an event-stream response, taking the JSON-RPC message out of the SSE framing", async () => {
    await new Promise((resolve) => server.close(resolve));
    await startServer((body, res) => {
      if (body.method === "initialize") {
        json(res, 200, { jsonrpc: "2.0", id: body.id, result: {} });
        return;
      }
      // A server that streams: the response arrives as an `message` event among the framing.
      sse(res, [{ event: "message", data: { jsonrpc: "2.0", id: body.id, result: { streamed: true } } }]);
    });
    const transport = new HttpMcpTransport({ id: "remote", url: baseUrl }, 5_000, () => {});
    try {
      await expect(transport.request("tools/list", {})).resolves.toMatchObject({ streamed: true });
    } finally {
      transport.close();
    }
  });

  it("delivers a notification carried inside an event stream to the handler", async () => {
    await new Promise((resolve) => server.close(resolve));
    await startServer((body, res) => {
      if (body.method === "initialize") {
        json(res, 200, { jsonrpc: "2.0", id: body.id, result: {} });
        return;
      }
      sse(res, [
        { event: "message", data: { jsonrpc: "2.0", method: "notifications/tools/list_changed" } },
        { event: "message", data: { jsonrpc: "2.0", id: body.id, result: { ok: true } } },
      ]);
    });
    const seen: string[] = [];
    const transport = new HttpMcpTransport({ id: "remote", url: baseUrl }, 5_000, (method) => seen.push(method));
    try {
      await transport.request("tools/list", {});
      expect(seen).toEqual(["notifications/tools/list_changed"]);
    } finally {
      transport.close();
    }
  });

  it("surfaces a JSON-RPC error as a rejected promise naming the server", async () => {
    await new Promise((resolve) => server.close(resolve));
    await startServer((body, res) => {
      json(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unknown method" } });
    });
    const transport = new HttpMcpTransport({ id: "remote", url: baseUrl }, 5_000, () => {});
    try {
      await expect(transport.request("bogus", {})).rejects.toThrow(/remote.*Unknown method/s);
    } finally {
      transport.close();
    }
  });

  it("rejects when the server answers with an HTTP error status", async () => {
    await new Promise((resolve) => server.close(resolve));
    await startServer((_body, res) => {
      json(res, 500, { error: "boom" });
    });
    const transport = new HttpMcpTransport({ id: "remote", url: baseUrl }, 5_000, () => {});
    try {
      await expect(transport.request("tools/list", {})).rejects.toThrow(/HTTP 500/);
      // One refused request is that request's failure; the next one still goes out.
      await expect(transport.request("tools/list", {})).rejects.toThrow(/HTTP 500/);
    } finally {
      transport.close();
    }
  });

  it("rejects a request that never gets a response within the timeout", async () => {
    await new Promise((resolve) => server.close(resolve));
    await startServer((_body, res) => {
      // Never responds: the socket stays open until the client's own timeout fires.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
    });
    const transport = new HttpMcpTransport({ id: "remote", url: baseUrl }, 100, () => {});
    try {
      await expect(transport.request("tools/list", {})).rejects.toThrow(/did not respond/);
    } finally {
      transport.close();
    }
  });
});

/** The session header the *request* carried — read off the IncomingMessage the handler closed over. */
function req_session(res: import("node:http").ServerResponse): string | undefined {
  return res.req.headers["mcp-session-id"] as string | undefined;
}
