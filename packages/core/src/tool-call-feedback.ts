/**
 * What the runtime tells a model whose tool call could not run: the closest real tool, the
 * parameters it takes, and when to stop guessing and look. Split out of agent-runtime.ts (WS-29).
 */
import { aliasTarget } from "./tool-aliases";

/**
 * What to tell a model that keeps failing the same way. The error already says what went wrong; what
 * a small model lacks is the instruction to stop guessing and look, and where to look depends on
 * the failure: "list the files" is no help to a call whose arguments have the wrong shape, or to a
 * command that only needed longer to run.
 */
export function repeatedFailureHint(toolName: string, failures: number, missingPathStreak: number, error = "", inputSchema?: unknown): string | null {
  if (failures >= 2) {
    if (/must be (a|an) |has no parameter|requires \w+|arguments must be/.test(error)) {
      const parameters = describeParameters(inputSchema);
      return `This exact ${toolName} call has now failed ${failures} times on its arguments. Do not send it again unchanged.${parameters ? ` ${toolName} takes: ${parameters}.` : ""}`;
    }
    if (/limit and was killed/.test(error)) {
      return `This command has now been stopped ${failures} times for running too long. Run it with a larger timeoutSeconds, or a smaller piece of the work at a time.`;
    }
    return `This exact ${toolName} call has now failed ${failures} times. Do not send it again unchanged: change the arguments, or run list_files with path "." to see what is really in the project.`;
  }
  if (missingPathStreak >= 3) {
    return "Several paths in a row did not exist. Stop guessing paths: run list_files with path \".\" (or glob_files with \"**/*\") and use only names it returns.";
  }
  return null;
}

/** A tool's parameters in a line: `path (string, required), offset (integer)`. */
function describeParameters(schema: unknown): string {
  const { properties = {}, required = [] } = (schema ?? {}) as { properties?: Record<string, { type?: string }>; required?: string[] };
  return Object.entries(properties)
    .map(([name, property]) => `${name} (${property.type ?? "any"}${required.includes(name) ? ", required" : ""})`)
    .join(", ");
}

/**
 * The tools most like a name the model invented: shared words in the name ("search" → web_search),
 * the word in a tool's description ("search" → grep_files, "Search file contents…"), then near-misses
 * in spelling ("read_files" → read_file). At most two, best first.
 */
export function suggestTools(name: string, tools: ReadonlyArray<{ name: string; description: string }>): string[] {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  const scored = tools.map((tool) => {
    const own = tool.name.toLowerCase();
    const ownWords = own.split(/[^a-z0-9]+/);
    const description = tool.description.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (ownWords.includes(word)) score += 3;
      else if (own.includes(word)) score += 2;
      else if (new RegExp(`\\b${word}`).test(description)) score += 1;
    }
    if (score === 0 && editDistance(name.toLowerCase(), own) <= 2) score = 2;
    return { name: tool.name, score };
  });
  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 2).map((entry) => entry.name);
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** What the model is told when it asks for a tool it cannot use: which case it is, and what to use. */
export function unavailableToolMessage(name: string, exists: boolean, available: ReadonlyArray<{ name: string; description: string; inputSchema?: unknown }>): string {
  const names = available.map((tool) => tool.name);
  const closest = suggestTools(name, available);
  // Only when the habit has one reading here: "search" could be the web or the files, and saying
  // it is grep_files would send a web question to grep.
  const target = exists ? undefined : aliasTarget(name, new Set(names));
  const tool = target && closest.every((candidate) => candidate === target) ? available.find((candidate) => candidate.name === target) : undefined;
  if (tool) {
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    const parts = [
      schema?.required?.length ? `needs ${schema.required.join(" and ")}` : "",
      schema?.properties && Object.keys(schema.properties).length ? `accepts ${Object.keys(schema.properties).join(", ")}` : "",
    ].filter(Boolean);
    const detail = parts.length ? ` It ${parts.join("; it ")}.` : "";
    return `"${name}" is ${target} here, but this call did not carry what ${target} needs.${detail} Call ${target} with those arguments.`;
  }
  const head = exists
    ? `${name} is not allowed in this run (the current mode does not include it).`
    : `There is no tool named "${name}".`;
  const hint = closest.length > 0 ? ` The closest: ${closest.join(" or ")}.` : "";
  return `${head}${hint} Tools you can call: ${names.join(", ")}. Use one of them, or answer without a tool.`;
}
