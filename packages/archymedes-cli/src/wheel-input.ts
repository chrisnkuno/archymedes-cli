export type WheelDirection = "up" | "down";
export type WheelInputSource = { emit(event: string | symbol, ...args: unknown[]): boolean };

const MOUSE_REPORT = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
const PARTIAL_REPORT = /\x1b(?:\[(?:<[\d;]*)?)?$/;
const MODIFIER_BITS = 4 | 8 | 16;
/** How long an incomplete escape at the end of a chunk waits for the rest before being passed on as typed. */
const PARTIAL_FLUSH_MS = 30;

/**
 * Removes SGR mouse reports from terminal input. Wheel notches are returned in order; clicks and
 * drags are dropped, since only the wheel is enabled for use. `pending` is an incomplete report
 * carried over from the previous chunk.
 */
export function extractWheel(chunk: string, pending = ""): { text: string; wheel: WheelDirection[]; pending: string } {
  const wheel: WheelDirection[] = [];
  let text = (pending + chunk).replace(MOUSE_REPORT, (_match, button: string) => {
    const code = Number(button) & ~MODIFIER_BITS;
    if (code === 64) wheel.push("up");
    else if (code === 65) wheel.push("down");
    return "";
  });
  const partial = PARTIAL_REPORT.exec(text)?.[0] ?? "";
  // Only a mouse-report prefix is held back; a bare trailing ESC is still a real Escape keypress.
  const hold = partial.startsWith("\x1b[<") ? partial : "";
  if (hold) text = text.slice(0, -hold.length);
  return { text, wheel, pending: hold };
}

/**
 * Filters mouse reports out of `input`'s data events before readline's keypress decoder sees them,
 * so a wheel notch scrolls instead of arriving in the composer as `[<65;12;9M`. Returns the uninstaller.
 */
export function installWheelFilter(input: WheelInputSource, onWheel: (direction: WheelDirection) => void): () => void {
  const original = input.emit;
  let pending = "";
  let flush: ReturnType<typeof setTimeout> | undefined;
  const patched = function (this: WheelInputSource, event: string | symbol, ...args: unknown[]): boolean {
    if (event !== "data") return original.call(this, event, ...args);
    clearTimeout(flush);
    const [chunk] = args;
    const result = extractWheel(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk), pending);
    pending = result.pending;
    if (pending) {
      flush = setTimeout(() => { const held = pending; pending = ""; original.call(input, "data", held); }, PARTIAL_FLUSH_MS);
      flush.unref?.();
    }
    for (const direction of result.wheel) onWheel(direction);
    return result.text === "" ? true : original.call(this, event, typeof chunk === "string" ? result.text : Buffer.from(result.text, "utf8"));
  };
  input.emit = patched;
  return () => {
    clearTimeout(flush);
    if (input.emit === patched) input.emit = original;
  };
}
