import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPasteStore, installBracketedPaste } from "./bracketed-paste";

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => { written += String(chunk); });
  const readline = createInterface({ input, output, terminal: true });
  const lines: string[] = [];
  readline.on("line", (line) => lines.push(line));
  return { input, readline, lines, written: () => written };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("pasted text", () => {
  it("keeps a multi-line paste as one submitted message", async () => {
    const store = createPasteStore();
    const t = terminal();
    const uninstall = installBracketedPaste({ readline: t.readline, output: { write: (text) => t.input.emit("unused", text) }, store });

    t.input.write("fix this:\x1b[200~TypeError: x is undefined\r\n    at parse (a.ts:3)\r\n    at main (b.ts:9)\x1b[201~ please\r");
    await tick();

    expect(t.lines).toEqual(["fix this:[Pasted 3 lines #1] please"]);
    expect(store.expand(t.lines[0])).toBe("fix this:TypeError: x is undefined\n    at parse (a.ts:3)\n    at main (b.ts:9) please");
    uninstall();
    t.readline.close();
  });

  it("inserts a single-line paste as ordinary text, and leaves typing alone", async () => {
    const store = createPasteStore();
    const t = terminal();
    installBracketedPaste({ readline: t.readline, output: { write: () => true }, store });

    t.input.write("run \x1b[200~the migration\x1b[201~ now\r");
    t.input.write("second line\r");
    await tick();

    expect(t.lines).toEqual(["run the migration now", "second line"]);
    t.readline.close();
  });

  it("turns bracketed-paste mode on, and off again when uninstalled", () => {
    const writes: string[] = [];
    const t = terminal();
    const uninstall = installBracketedPaste({ readline: t.readline, output: { write: (text) => writes.push(text) }, store: createPasteStore() });
    uninstall();
    expect(writes).toEqual(["[?2004h", "[?2004l"]);
    t.readline.close();
  });

  it("leaves unknown placeholders as typed and bounds what it keeps", () => {
    const store = createPasteStore();
    expect(store.expand("see [Pasted 2 lines #99]")).toBe("see [Pasted 2 lines #99]");
    const first = store.insertionFor("a\nb");
    for (let i = 0; i < 60; i++) store.insertionFor(`x\n${i}`);
    expect(store.expand(first)).toBe(first);
  });

  it("does nothing on a readline without the internals it needs", () => {
    const writes: string[] = [];
    const uninstall = installBracketedPaste({ readline: {}, output: { write: (text) => writes.push(text) }, store: createPasteStore() });
    uninstall();
    expect(writes).toEqual([]);
  });
});
