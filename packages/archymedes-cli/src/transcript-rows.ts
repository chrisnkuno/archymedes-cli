import { RESET } from "./ansi";
import { visibleWidth } from "./markdown";

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const NON_SGR_CSI = /\x1b\[(?![0-9;]*m)[0-?]*[ -/]*[@-~]/g;
const OTHER_ESCAPE = /\x1b(?:[^\[]|$)|\x1b\[(?![0-9;]*m)[0-?]*$/g;
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g;
const SGR_SPLIT = /(\x1b\[[0-9;]*m)/;
const TAB_STOP = 8;
/** Styles still open are replayed at the start of each row; bounded so a stream that never resets cannot grow it. */
const MAX_OPEN_STYLES = 8;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Retained output with every cursor-moving or terminal-mode escape removed; colour and weight survive. */
export function sanitizeTranscript(text: string): string {
  return text.replace(OSC, "").replace(NON_SGR_CSI, "").replace(OTHER_ESCAPE, "").replace(CONTROLS, "")
    .split("\n").map((line) => line.replace(/^[^\n]*\r(?=[^\r])/, "").replace(/\r/g, "")).join("\n");
}

function nextStyles(open: string[], sequence: string): string[] {
  const params = sequence.slice(2, -1);
  if (params === "" || params === "0") return [];
  if (params.startsWith("0;")) return [`\x1b[${params.slice(2)}m`];
  return [...open, sequence].slice(-MAX_OPEN_STYLES);
}

/**
 * Wraps retained transcript text into rows no wider than `width`, keeping SGR styling: a style still
 * open at a wrap or line break is closed at the end of the row and reopened at the start of the next,
 * so any row can be painted on its own.
 */
export function transcriptRows(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let open: string[] = [];
  for (const line of sanitizeTranscript(text).split("\n")) {
    let row = open.join("");
    let used = 0;
    const push = () => { rows.push(open.length > 0 ? row + RESET : row); row = open.join(""); used = 0; };
    for (const part of line.split(SGR_SPLIT)) {
      if (part === "") continue;
      if (part.startsWith("\x1b[")) {
        open = nextStyles(open, part);
        row += part;
        continue;
      }
      for (const { segment } of graphemes.segment(part)) {
        if (segment === "\t") {
          let spaces = TAB_STOP - (used % TAB_STOP);
          if (used + spaces > limit) {
            if (used > 0) push();
            spaces = Math.min(TAB_STOP, limit);
          }
          row += " ".repeat(spaces);
          used += spaces;
          continue;
        }
        const size = visibleWidth(segment);
        if (used + size > limit && used > 0) push();
        row += size > limit ? "?" : segment;
        used += Math.min(size, limit);
      }
    }
    push();
  }
  return rows;
}
