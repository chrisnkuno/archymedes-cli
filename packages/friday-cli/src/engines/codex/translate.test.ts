import { describe, expect, it } from "vitest";
import type { ArchymedesEvent } from "@archymedes/core/cli/agent";
import { CodexTranslator, codexErrorText, unwrapShell, MAX_RESULT_CHARS } from "./translate";

const ROOT = "/work/project";
type Runtime = Extract<ArchymedesEvent, { type: "runtime" }>["event"];
const runtimeOf = (events: ArchymedesEvent[]): Runtime[] => events.flatMap((event) => (event.type === "runtime" ? [event.event] : []));

describe("Codex's stream, as Friday's events", () => {
  it("unwraps the shell Codex runs a command in", () => {
    expect(unwrapShell(`/bin/bash -lc "sed -n '1,120p' greet.py && python3 greet.py"`)).toBe("sed -n '1,120p' greet.py && python3 greet.py");
    expect(unwrapShell("/bin/bash -lc 'python3 greet.py'")).toBe("python3 greet.py");
    expect(unwrapShell(`bash -c "echo \\"hi\\""`)).toBe(`echo "hi"`);
    expect(unwrapShell("bash -lc 'it'\\''s'")).toBe("it's");
    expect(unwrapShell("npm test")).toBe("npm test");
  });

  it("reads the provider's sentence out of Codex's JSON error", () => {
    expect(codexErrorText(JSON.stringify({ type: "error", status: 400, error: { message: "Not on your plan." } }))).toBe("Not on your plan.");
    expect(codexErrorText("plain words")).toBe("plain words");
    // The refusal a ChatGPT account gives for a model its plan lacks says what to do next.
    const refused = codexErrorText(JSON.stringify({ type: "error", status: 400, error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", code: "model_not_found" } }));
    expect(refused).toMatch(/^The 'gpt-6.1-sol' model is not supported .*model picker \(\/model\).*config\.toml\.$/);
  });

  it("sends a message's text once whether it streamed or arrived whole", () => {
    const translator = new CodexTranslator(ROOT);
    translator.begin();
    const events = [
      ...translator.feed("item/agentMessage/delta", { itemId: "a", delta: "Hel" }),
      ...translator.feed("item/agentMessage/delta", { itemId: "a", delta: "lo" }),
      ...translator.feed("item/completed", { item: { type: "agentMessage", id: "a", text: "Hello", phase: "commentary" } }),
      ...translator.feed("item/completed", { item: { type: "agentMessage", id: "b", text: "Done.", phase: "final_answer" } }),
    ];
    expect(runtimeOf(events).map((event) => (event.type === "assistant_delta" ? event.text : event.type))).toEqual(["Hel", "lo", "Done."]);
    const { outcome } = translator.finish({ status: "completed" });
    expect(outcome).toEqual({ status: "completed", summary: "Done.", text: "Hello\n\nDone." });
  });

  it("keeps results bounded, names new files as written, and shows paths relative to the project", () => {
    const translator = new CodexTranslator(ROOT);
    translator.begin();
    const item = { type: "fileChange", id: "f", changes: [{ path: `${ROOT}/src/new.ts`, kind: { type: "add" }, diff: "+x" }], status: "inProgress" };
    const started = runtimeOf(translator.feed("item/started", { item }));
    expect(started[0]).toMatchObject({ type: "tool_call", toolName: "write_file", arguments: { path: "src/new.ts" } });
    expect(translator.pathsOf("f")).toEqual(["src/new.ts"]);
    const cmd = { type: "commandExecution", id: "c", command: "cat big", status: "inProgress" };
    translator.feed("item/started", { item: cmd });
    const [result] = runtimeOf(translator.feed("item/completed", { item: { ...cmd, status: "completed", exitCode: 0, aggregatedOutput: "x".repeat(MAX_RESULT_CHARS * 2) } }));
    expect(result.type === "tool_result" && result.content.length).toBeLessThan(MAX_RESULT_CHARS + 100);
  });

  // Seeded random streams: items started and completed out of order, twice, or never; deltas for
  // messages that also arrive whole; usage at random points; then any way a turn can end.
  it.each(Array.from({ length: 300 }, (_, seed) => seed + 1))("keeps its invariants on random stream %i", (seed) => {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const translator = new CodexTranslator(ROOT);
    for (let turn = 0; turn < 3; turn += 1) {
      translator.begin();
      const events: ArchymedesEvent[] = [];
      const said: string[] = [];
      const streamed = new Set<string>();
      const toolIds = ["t1", "t2", "t3", "t4"];
      for (let step = 0; step < 40; step += 1) {
        const id = pick(toolIds);
        const message = pick(["m1", "m2", "m3"]);
        switch (pick(["delta", "messageDone", "start", "done", "usage", "plan", "noise"])) {
          case "delta": {
            const text = `d${step} `;
            streamed.add(message);
            said.push(text);
            events.push(...translator.feed("item/agentMessage/delta", { itemId: message, delta: text }));
            break;
          }
          case "messageDone": {
            const text = `whole-${message}`;
            if (!streamed.has(message)) { said.push(text); streamed.add(message); }
            events.push(...translator.feed("item/completed", { item: { type: "agentMessage", id: message, text } }));
            break;
          }
          case "start":
            events.push(...translator.feed("item/started", { item: { type: pick(["commandExecution", "fileChange", "webSearch", "mcpToolCall", "reasoning"]), id, command: "ls", changes: [], status: "inProgress" } }));
            break;
          case "done":
            events.push(...translator.feed("item/completed", { item: { type: "commandExecution", id, command: "ls", status: pick(["completed", "failed"]), exitCode: pick([0, 1, null]), aggregatedOutput: "out" } }));
            break;
          case "usage":
            events.push(...translator.feed("thread/tokenUsage/updated", { turnId: "t", tokenUsage: { last: { inputTokens: 5, outputTokens: 1 } } }));
            break;
          case "plan":
            events.push(...translator.feed("turn/plan/updated", { plan: [{ step: "x", status: "inProgress" }] }));
            break;
          default:
            events.push(...translator.feed("thread/status/changed", { status: { type: "active" } }));
        }
      }
      const ending = pick([{ status: "completed" }, { status: "interrupted" }, { status: "failed", error: "boom" }, undefined]);
      const finished = translator.finish(ending, pick([{}, { cancelled: true }, { error: "Codex stopped" }]));
      events.push(...finished.events);
      events.push(...translator.feed("item/agentMessage/delta", { itemId: "late", delta: "after the end" }));

      const runtime = runtimeOf(events);
      const text = runtime.flatMap((event) => (event.type === "assistant_delta" ? [event.text] : [])).join("");
      expect(text).toBe(said.join(""));
      expect(runtime.filter((event) => event.type === "runtime_stop")).toHaveLength(1);
      expect(runtime.at(-1)?.type).toBe("runtime_stop");
      const announced = new Set<string>();
      const answered = new Set<string>();
      for (const event of runtime) {
        if (event.type === "tool_call") {
          expect(announced.has(event.toolCallId) && !answered.has(event.toolCallId)).toBe(false); // never announced twice while open
          announced.add(event.toolCallId);
          answered.delete(event.toolCallId);
        }
        if (event.type === "tool_result") {
          expect(announced.has(event.toolCallId)).toBe(true);
          expect(answered.has(event.toolCallId)).toBe(false);
          answered.add(event.toolCallId);
        }
      }
      expect([...announced].every((callId) => answered.has(callId))).toBe(true);
    }
  });
});

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
