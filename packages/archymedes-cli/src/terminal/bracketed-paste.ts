/**
 * Pastes arrive as one message, not one message per line.
 *
 * readline treats every newline as Enter, so pasting a stack trace or a multi-line instruction used
 * to submit it line by line: the first line went to the model on its own and the rest queued behind
 * it as separate turns. Terminals mark a paste with `ESC[200~ … ESC[201~` once bracketed-paste mode
 * is on, and Node's keypress parser reports those as `paste-start`/`paste-end` — which readline then
 * ignores. This module turns the mode on, captures what arrives between the markers, and hands
 * readline a single line: the text itself when it has no newline, or a short placeholder when it
 * does, which `expand` swaps back for the full text when the line is submitted. The placeholder
 * keeps the prompt one row high; readline cannot edit a line that contains newlines.
 */

const ENABLE = "[?2004h";
const DISABLE = "[?2004l";
const PLACEHOLDER = /\[Pasted (\d+) lines #(\d+)\]/g;
/** Bounded so a long session of pastes cannot grow without limit; the oldest are dropped first. */
const MAX_STORED = 50;

export type PasteStore = {
  /** The text readline should receive for a paste. */
  insertionFor(text: string): string;
  /** A submitted line with every placeholder this store knows replaced by its text. */
  expand(line: string): string;
};

export function createPasteStore(): PasteStore {
  const pastes = new Map<number, string>();
  let next = 1;
  return {
    insertionFor(raw) {
      const text = raw.replace(/\r\n?/g, "\n");
      if (!text.includes("\n")) return text;
      const id = next++;
      pastes.set(id, text);
      if (pastes.size > MAX_STORED) pastes.delete(pastes.keys().next().value!);
      return `[Pasted ${text.split("\n").length} lines #${id}]`;
    },
    expand(line) {
      return line.replace(PLACEHOLDER, (placeholder, _lines: string, id: string) => pastes.get(Number(id)) ?? placeholder);
    },
  };
}

type KeyLike = { name?: string } | undefined;
type TtyWrite = (sequence: string | undefined, key: KeyLike) => void;

/** readline keeps these behind symbols; found by description so a runtime without them is left alone. */
function internal(target: object, description: string): symbol | undefined {
  for (let object: object | null = target; object; object = Object.getPrototypeOf(object)) {
    const found = Object.getOwnPropertySymbols(object).find((symbol) => symbol.description === description);
    if (found) return found;
  }
  return undefined;
}

/**
 * Installs paste capture on one readline interface and returns the uninstaller. Returns a no-op when
 * the runtime's readline lacks the internals this needs, which leaves the old line-by-line behaviour.
 */
export function installBracketedPaste(options: {
  readline: object;
  output: { write(text: string): unknown };
  store: PasteStore;
}): () => void {
  const target = options.readline as Record<symbol, unknown>;
  const ttyWriteKey = internal(target, "_ttyWrite");
  const insertKey = internal(target, "_insertString");
  if (!ttyWriteKey || !insertKey || typeof target[ttyWriteKey] !== "function" || typeof target[insertKey] !== "function") {
    return () => {};
  }
  const original = target[ttyWriteKey] as TtyWrite;
  const insert = (text: string) => (target[insertKey] as (text: string) => void).call(target, text);
  let pasting = false;
  let buffer = "";

  const own = Object.getOwnPropertyDescriptor(target, ttyWriteKey);
  // Defined rather than assigned: the public Interface exposes this symbol through a getter.
  const capture = function (sequence: string | undefined, key: KeyLike) {
    if (key?.name === "paste-start") {
      pasting = true;
      buffer = "";
      return;
    }
    if (key?.name === "paste-end") {
      pasting = false;
      const text = options.store.insertionFor(buffer);
      buffer = "";
      if (text) insert(text);
      return;
    }
    if (pasting) {
      // Raw, so a CRLF paste (reported as two keys, return then enter) is one break after normalizing.
      buffer += sequence ?? "";
      return;
    }
    original.call(target, sequence, key);
  } as TtyWrite;
  Object.defineProperty(target, ttyWriteKey, { value: capture, configurable: true, writable: true });
  options.output.write(ENABLE);

  return () => {
    if (own) Object.defineProperty(target, ttyWriteKey, own);
    else delete target[ttyWriteKey];
    options.output.write(DISABLE);
  };
}
