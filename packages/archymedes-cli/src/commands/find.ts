import type { FindRequest, FindResult } from "../ui/workspace-frame";

/**
 * `/find <text>` searches; a bare `/find` (or `/find next`) moves to the next match, `/find prev` to
 * the previous one, and `/find off` returns to live output. Quote a query to search for one of those
 * words literally: `/find "next"`.
 */
export function parseFindCommand(input: string): FindRequest | null {
  if (input !== "/find" && !input.startsWith("/find ")) return null;
  const rest = input.slice("/find".length).trim();
  if (rest === "" || rest === "next") return { kind: "next" };
  if (rest === "prev" || rest === "previous") return { kind: "prev" };
  if (rest === "off" || rest === "clear") return { kind: "off" };
  const quoted = /^(["'])(.*)\1$/.exec(rest);
  return { kind: "query", text: quoted ? quoted[2] : rest };
}

/**
 * What to say after a search, or null when the header already says it. A match is shown by the
 * workspace header (`FIND 2/7`), so writing a line would only add "+1 new" to what is being read.
 */
export function describeFind(result: FindResult | undefined): string | null {
  if (!result) return "Search needs the fixed workspace (/layout fixed); in scrollback, use your terminal's own find.";
  switch (result.status) {
    case "found": return null;
    case "none": return `No match for "${result.query}".`;
    case "idle": return "Nothing to step through yet: /find <text> starts a search.";
    case "cleared": return null;
  }
}
