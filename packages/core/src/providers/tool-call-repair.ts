/**
 * Repairs the tool-call arguments small free models get almost right.
 *
 * A free model's arguments often arrive as JSON with a trailing comma, wrapped in a ```json fence,
 * single-quoted, as an already-parsed object, as an empty string for a no-argument call, or with the
 * final closing brace missing. Each of those is unambiguous — there is exactly one object the model
 * meant — so repairing it costs nothing, where rejecting it costs a whole extra request of a
 * rationed day. Anything ambiguous is left alone: the runtime then rejects the call and tells the
 * model once what was wrong (see `MAX_TOOL_TURN_RECOVERIES`).
 *
 * Used by free mode only. Paid providers keep the strict reading, because there a malformed call
 * is a rare event worth surfacing rather than a routine one worth smoothing over.
 */
import type { AgentToolCall } from "../agent-runtime";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    // Not JSON (yet): the caller tries the next repair.
    return undefined;
  }
}

/** Removes commas that directly precede `}` or `]`, outside strings. */
function withoutTrailingCommas(text: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      result += char;
      if (char === "\\") { result += text[index + 1] ?? ""; index += 1; } else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; result += char; continue; }
    if (char === ",") {
      const rest = text.slice(index + 1).trimStart();
      if (rest.startsWith("}") || rest.startsWith("]")) continue;
    }
    result += char;
  }
  return result;
}

/**
 * Single-quoted strings to double-quoted, only when the text has no double quotes at all — then
 * there is no mixing to misread. An apostrophe inside a single-quoted value would be ambiguous, and
 * produces invalid JSON here, which is then rejected rather than guessed at.
 */
function singleToDoubleQuotes(text: string): string | undefined {
  if (text.includes("\"") || !text.includes("'")) return undefined;
  return text.replace(/'/g, "\"");
}

/** Closes brackets left open at the end, outside strings; undefined when the text is unbalanced otherwise. */
function closeOpenBrackets(text: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1; else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") { if (stack.pop() !== char) return undefined; }
  }
  // An unterminated string is a truncated value, not a missing brace: not safe to complete.
  if (inString || stack.length === 0 || stack.length > 2) return undefined;
  return text + stack.reverse().join("");
}

/**
 * The arguments object a free model meant, or the original value when it cannot be repaired
 * unambiguously (the runtime then rejects the call and asks the model to retry).
 */
export function repairToolArguments(value: unknown): unknown {
  if (isObject(value)) return value;
  if (typeof value !== "string") return value;
  let text = value.trim();
  if (!text) return {};
  const fenced = /^```[a-z]*\s*\n?([\s\S]*?)\n?\s*```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  const direct = parseObject(text);
  if (direct) return direct;
  // A JSON string that itself holds the object (double-encoded arguments).
  try {
    const inner: unknown = JSON.parse(text);
    if (typeof inner === "string") {
      const parsed = parseObject(inner);
      if (parsed) return parsed;
    }
  } catch {
    // Not a JSON string either; the textual repairs below are next.
  }
  const quoted = singleToDoubleQuotes(text) ?? text;
  const trimmed = withoutTrailingCommas(quoted);
  const repaired = parseObject(trimmed);
  if (repaired) return repaired;
  const closed = closeOpenBrackets(trimmed);
  const completed = closed ? parseObject(withoutTrailingCommas(closed)) : undefined;
  return completed ?? value;
}

/** Every call of a turn with its arguments repaired where that is unambiguous. */
export function repairToolCalls(calls: readonly AgentToolCall[]): AgentToolCall[] {
  return calls.map((call) => {
    const repaired = repairToolArguments(call.arguments);
    return repaired === call.arguments ? call : { ...call, arguments: repaired };
  });
}
