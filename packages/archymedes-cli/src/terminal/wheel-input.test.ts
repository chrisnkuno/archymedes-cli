import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWheel, installWheelFilter } from "./wheel-input";

describe("wheel input", () => {
  afterEach(() => vi.useRealTimers());

  it("extracts wheel notches with modifiers and drops clicks, keeping typed text", () => {
    expect(extractWheel("a\x1b[<64;10;5Mb\x1b[<69;1;1M\x1b[<0;3;4M\x1b[<0;3;4mc")).toEqual({ text: "abc", wheel: ["up", "down"], pending: "" });
  });

  it("holds an incomplete report for the next chunk but not a real Escape", () => {
    const first = extractWheel("x\x1b[<65;1");
    expect(first).toEqual({ text: "x", wheel: [], pending: "\x1b[<65;1" });
    expect(extractWheel(";2M", first.pending)).toEqual({ text: "", wheel: ["down"], pending: "" });
    expect(extractWheel("\x1b")).toEqual({ text: "\x1b", wheel: [], pending: "" });
  });

  it("filters data events before other listeners and restores the stream", () => {
    const input = new EventEmitter();
    const received: string[] = [];
    const wheel: string[] = [];
    input.on("data", (chunk: Buffer | string) => received.push(String(chunk)));
    const uninstall = installWheelFilter(input, (direction) => wheel.push(direction));
    input.emit("data", Buffer.from("hi\x1b[<64;1;1M"));
    input.emit("data", "\x1b[<65;1;1M");
    input.emit("end");
    expect(received).toEqual(["hi"]);
    expect(wheel).toEqual(["up", "down"]);
    uninstall();
    input.emit("data", "\x1b[<64;1;1M");
    expect(received.at(-1)).toBe("\x1b[<64;1;1M");
  });

  it("passes a held prefix through when the rest never arrives", () => {
    vi.useFakeTimers();
    const input = new EventEmitter();
    const received: string[] = [];
    input.on("data", (chunk: string) => received.push(chunk));
    installWheelFilter(input, () => undefined);
    input.emit("data", "\x1b[<");
    expect(received).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(received).toEqual(["\x1b[<"]);
  });
});
