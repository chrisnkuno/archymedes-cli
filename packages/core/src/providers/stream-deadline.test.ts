import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableProviderError, providerFailureKind } from "../agent-runtime";
import {
  createStreamDeadline, DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS,
  StreamTimeoutError, streamTimeoutsFor,
} from "./stream-deadline";

/** A stream whose chunks are released by hand, so the test controls the silence between them. */
function manualStream<T>() {
  const queue: Array<(result: IteratorResult<T>) => void> = [];
  const pending: Array<IteratorResult<T>> = [];
  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<T>>((resolve) => {
          const ready = pending.shift();
          if (ready) resolve(ready); else queue.push(resolve);
        }),
      };
    },
  };
  const push = (result: IteratorResult<T>) => { const waiter = queue.shift(); if (waiter) waiter(result); else pending.push(result); };
  return { iterable, emit: (value: T) => push({ value, done: false }), end: () => push({ value: undefined as never, done: true }) };
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("stream deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fails a stream that never sends its first chunk, with a timeout the runtime classifies as one", async () => {
    const deadline = createStreamDeadline({ firstByteMs: 1_000, idleMs: 100, totalMs: 60_000 });
    const stream = manualStream<string>();
    const pending = drain(deadline.wrap(stream.iterable)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(999);
    expect(deadline.timedOut).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(StreamTimeoutError);
    expect(error).toMatchObject({ name: "TimeoutError", code: "ETIMEDOUT", phase: "first_byte" });
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(error);
    expect(providerFailureKind(error)).toBe("timeout");
    expect(isRetryableProviderError(error)).toBe(true);
    deadline.dispose();
  });

  it("keeps a long stream alive as long as chunks keep arriving, however long it runs in total", async () => {
    const deadline = createStreamDeadline({ firstByteMs: 1_000, idleMs: 500, totalMs: 60_000 });
    const stream = manualStream<number>();
    const pending = drain(deadline.wrap(stream.iterable));
    // 40 chunks, 400ms apart: 16s in total, far past the idle timeout, never idle for 500ms.
    for (let index = 0; index < 40; index += 1) {
      await vi.advanceTimersByTimeAsync(400);
      stream.emit(index);
    }
    stream.end();
    await expect(pending).resolves.toHaveLength(40);
    expect(deadline.timedOut).toBeUndefined();
    expect(deadline.started).toBe(true);
    deadline.dispose();
  });

  it("fails a stream that goes silent after it started", async () => {
    const deadline = createStreamDeadline({ firstByteMs: 10_000, idleMs: 500, totalMs: 60_000 });
    const stream = manualStream<number>();
    const pending = drain(deadline.wrap(stream.iterable)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    stream.emit(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(deadline.timedOut).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ phase: "idle" });
    deadline.dispose();
  });

  it("enforces the overall cap even on a stream that never goes idle", async () => {
    const deadline = createStreamDeadline({ firstByteMs: 1_000, idleMs: 500, totalMs: 3_000 });
    const stream = manualStream<number>();
    const pending = drain(deadline.wrap(stream.iterable)).catch((error: unknown) => error);
    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(400);
      stream.emit(index);
    }
    await expect(pending).resolves.toMatchObject({ phase: "total" });
    deadline.dispose();
  });

  it("races a request that ignores its abort signal", async () => {
    const deadline = createStreamDeadline({ firstByteMs: 1_000 });
    const pending = deadline.race(new Promise<never>(() => undefined)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ phase: "first_byte" });
    deadline.dispose();
  });

  it("follows the caller's abort without reporting it as a timeout", async () => {
    const controller = new AbortController();
    const deadline = createStreamDeadline({ signal: controller.signal, firstByteMs: 1_000 });
    controller.abort(new Error("user cancelled"));
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({ message: "user cancelled" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deadline.timedOut).toBeUndefined();
    deadline.dispose();
  });

  it("stops every timer once disposed", async () => {
    const deadline = createStreamDeadline({ firstByteMs: 1_000 });
    deadline.dispose();
    await vi.advanceTimersByTimeAsync(DEFAULT_TOTAL_TIMEOUT_MS);
    expect(deadline.timedOut).toBeUndefined();
    expect(deadline.signal.aborted).toBe(false);
  });

  it("maps the legacy single timeoutMs onto the idle timeout without shortening the others", () => {
    expect(streamTimeoutsFor()).toEqual({ firstByteMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS, idleMs: DEFAULT_IDLE_TIMEOUT_MS, totalMs: DEFAULT_TOTAL_TIMEOUT_MS });
    expect(streamTimeoutsFor(180_000)).toEqual({ firstByteMs: 300_000, idleMs: 180_000, totalMs: DEFAULT_TOTAL_TIMEOUT_MS });
    expect(streamTimeoutsFor(600_000)).toMatchObject({ firstByteMs: 600_000, idleMs: 600_000 });
    expect(streamTimeoutsFor(undefined, { firstByteMs: 45_000 })).toMatchObject({ firstByteMs: 45_000, idleMs: DEFAULT_IDLE_TIMEOUT_MS });
  });
});
