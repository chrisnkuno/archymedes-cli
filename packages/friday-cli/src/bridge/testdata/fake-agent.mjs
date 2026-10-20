// A stand-in for `friday acp`: the handshake, a streamed reply, an approval request, and ways to die.
import readline from "node:readline";

if (process.env.FAKE_DIE_AFTER_MS) setTimeout(() => process.exit(5), Number(process.env.FAKE_DIE_AFTER_MS));

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const chunk = (sessionId, text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: Number(process.env.FAKE_PROTOCOL ?? 1) } });
  if (message.method === "session/new") return send({ id: message.id, result: { sessionId: `agent-${process.pid}`, _meta: { archymedes: { mode: "build", model: "fake-model", provider: "fake" } } } });
  if (message.method === "session/load") {
    if (process.env.FAKE_NO_LOAD) return send({ id: message.id, error: { code: -32000, message: "no such session" } });
    return send({ id: message.id, result: { _meta: { archymedes: { mode: "build", model: "fake-model" } } } });
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    const text = message.params.prompt[0].text;
    if (text === "die") process.exit(3);
    if (text === "env") {
      chunk(sessionId, JSON.stringify({ cwd: process.cwd(), telemetry: process.env.ARCHYMEDES_TELEMETRY, key: process.env.TEST_KEY, bridgeConfig: process.env.FRIDAY_BRIDGE_CONFIG ?? null }));
    } else if (text === "ask") {
      send({ id: 7, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "t1", title: "write app.ts" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
      return; // the turn ends when the approval is answered
    } else {
      chunk(sessionId, `hello ${text}`);
    }
    return send({ id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.id === 7 && message.result) {
    chunk("agent", `answered ${JSON.stringify(message.result)}`);
    return send({ id: "p-ask", result: { stopReason: "end_turn" } });
  }
});
