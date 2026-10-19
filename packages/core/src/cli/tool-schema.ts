/**
 * One source of truth for what a tool accepts.
 *
 * Every tool used to declare its arguments twice: once as the JSON Schema the model is shown, and
 * again as hand-written checks inside `execute` — `requiredString(args.path)` beside a schema that
 * already said `path` was a required string. Two declarations of the same thing drift.
 *
 * Validating against the declared schema makes the schema authoritative, which buys three things
 * the scattered checks did not:
 *
 * - **Unknown parameters are refused.** Every schema declares `additionalProperties: false`, and
 *   nothing enforced it. A model inventing `write_file({ mode: "append" })` had the extra argument
 *   silently dropped and was told the write succeeded — which, as it asked for it, it had not.
 * - **One enforcement point instead of one per backend.** Type guards live in `LocalWorkspace` and
 *   again in `E2BWorkspace`; each new backend has to remember every one of them. Checking above
 *   the backend means a tool cannot reach *any* workspace with arguments of the wrong shape.
 * - **Nothing partially applied.** Arguments are checked before `execute` runs, so a call that is
 *   going to be rejected is rejected before it has done half its work.
 *
 * The supported subset is deliberately small — it is exactly what Archymedes's tools use, and a schema
 * feature nobody declares is a feature that cannot be tested. `assertSupportedSchema` fails loudly
 * on anything outside it rather than silently skipping validation, because a schema that quietly
 * validates nothing is worse than no validation at all.
 */

export type ScalarType = "string" | "integer" | "boolean";

/** An array item that is an object of scalars, such as one of edit_file's `edits`. */
export type ObjectItemSchema = { type: "object"; properties: Record<string, { type: ScalarType; description?: string }>; required?: string[]; additionalProperties?: false };

export type PropertySchema =
  | { type: ScalarType; description?: string }
  | { type: "array"; items: { type: ScalarType } | ObjectItemSchema; description?: string };

export type ToolInputSchema = {
  type: "object";
  properties?: Record<string, PropertySchema>;
  required?: string[];
  additionalProperties?: false;
};

/** Thrown for arguments a model can fix by reading the message. Surfaced to it as a tool error. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rejects a schema this validator cannot honour.
 *
 * Called for every tool at construction, so an unsupported schema is a startup failure rather than
 * a validation that silently passes everything at run time.
 */
export function assertSupportedSchema(toolName: string, schema: unknown): asserts schema is ToolInputSchema {
  if (!isPlainObject(schema)) throw new Error(`Tool ${toolName} has no input schema`);
  if (schema.type !== "object") throw new Error(`Tool ${toolName} input schema must be an object schema`);
  if (schema.additionalProperties !== false) throw new Error(`Tool ${toolName} input schema must set additionalProperties: false`);
  const properties = schema.properties ?? {};
  if (!isPlainObject(properties)) throw new Error(`Tool ${toolName} input schema properties must be an object`);
  for (const [name, property] of Object.entries(properties)) {
    if (!isPlainObject(property)) throw new Error(`Tool ${toolName} property ${name} must be a schema object`);
    const type = property.type;
    if (type === "array") {
      const items = property.items;
      if (isPlainObject(items) && items.type === "object") {
        const fields = isPlainObject(items.properties) ? items.properties : null;
        if (!fields || Object.values(fields).some((field) => !isPlainObject(field) || !["string", "integer", "boolean"].includes(field.type as string))) {
          throw new Error(`Tool ${toolName} property ${name} must declare object items of scalar fields`);
        }
        continue;
      }
      if (!isPlainObject(items) || !["string", "integer", "boolean"].includes(items.type as string)) {
        throw new Error(`Tool ${toolName} property ${name} must declare scalar array items`);
      }
      continue;
    }
    if (!["string", "integer", "boolean"].includes(type as string)) {
      throw new Error(`Tool ${toolName} property ${name} has unsupported type ${String(type)}`);
    }
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required)) throw new Error(`Tool ${toolName} input schema required must be an array`);
  for (const name of required) {
    if (typeof name !== "string" || !(name in properties)) {
      throw new Error(`Tool ${toolName} requires ${String(name)}, which it does not declare`);
    }
  }
}

/**
 * Parameter names models bring from other tool sets, and the name each one means here.
 *
 * Applied only when the tool declares the target and does not declare the synonym itself, so a
 * synonym never shadows a real parameter. `file_path` means `path` to every tool that has a `path`;
 * that is the whole rule.
 */
const PARAMETER_SYNONYMS: Record<string, readonly string[]> = {
  path: ["file_path", "filePath", "filepath", "file", "filename", "target_file", "absolute_path", "relative_path", "dir", "directory"],
  content: ["contents", "file_text", "text", "data"],
  oldText: ["old_string", "old_str", "oldString", "old_text", "search"],
  newText: ["new_string", "new_str", "newString", "new_text", "replacement"],
  replaceAll: ["replace_all"],
  command: ["cmd", "shell_command", "script"],
  timeoutMs: ["timeout_ms"],
  timeoutSeconds: ["timeout", "timeout_seconds", "timeout_secs", "timeoutSecs"],
  query: ["q", "search_query"],
  pattern: ["glob"],
  include: ["include_pattern", "file_pattern"],
  url: ["uri", "link"],
};

/**
 * A value of the wrong type turned into the declared one, when exactly one reading exists; undefined
 * when there is no such reading and the call should be refused.
 */
function coerceScalar(type: ScalarType, value: unknown): unknown {
  if (type === "string") {
    // Structured data where a string is declared: the tool takes JSON text (edit_file's `edits`).
    if (typeof value === "object" && value !== null) return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return String(value);
    return undefined;
  }
  if (type === "integer") {
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value - Math.round(value)) < 1e-9) return Math.round(value);
    if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) return Number(value.trim());
    return undefined;
  }
  if (typeof value === "string" && /^\s*(true|false)\s*$/i.test(value)) return value.trim().toLowerCase() === "true";
  return undefined;
}

function describe(value: unknown): string {
  return Array.isArray(value) ? "an array" : value === null ? "null" : typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function checkScalar(type: ScalarType, value: unknown, label: string): void {
  if (type === "string") {
    if (typeof value !== "string") throw new ToolArgumentError(`${label} must be a string`);
    return;
  }
  if (type === "integer") {
    // `Number.isInteger` rejects NaN, Infinity and 1.5 together, which is the whole point: a
    // non-finite "integer" reaching a timeout or an offset is a hang or a crash, not a small error.
    if (!Number.isInteger(value)) throw new ToolArgumentError(`${label} must be an integer`);
    return;
  }
  if (typeof value !== "boolean") throw new ToolArgumentError(`${label} must be true or false`);
}

/** Arguments made valid, and what was changed to make them so, for the model to read. */
export type NormalizedArguments = { value: Record<string, unknown>; notes: string[] };

/**
 * One tool call's arguments, checked against the declared schema, with unambiguous mistakes repaired.
 *
 * This used to check without coercing, on the theory that a model told it sent the wrong type fixes
 * it next turn. In practice a model often does not: it sends the same call again, and each refusal
 * is a whole round trip (on a free model, a request out of a rationed day) spent on something
 * nobody was confused about. `edits` sent as an array where JSON text is declared, `"30"` for 30,
 * `file_path` for `path`: each has exactly one meaning. Those are repaired, the call runs, and the
 * repair is reported back (`notes`), so the model still learns without losing the turn.
 *
 * What is still refused, because guessing would do the wrong thing: a parameter with no known
 * meaning (`write_file({ mode: "append" })` must not silently become an overwrite), a required
 * value that is missing, and a value with no single reading as the declared type.
 *
 * `null` for an absent optional value is dropped: models routinely send explicit nulls for
 * parameters they are not using.
 */
export function normalizeToolArguments(toolName: string, schema: ToolInputSchema, args: unknown): NormalizedArguments {
  let input = args;
  const notes: string[] = [];
  // Arguments as JSON text rather than an object: one reading, if it parses to an object.
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (isPlainObject(parsed)) {
        input = parsed;
        notes.push("arguments were JSON text; read as an object");
      }
    } catch {
      // Not JSON: refused below.
    }
  }
  if (!isPlainObject(input)) throw new ToolArgumentError(`${toolName} arguments must be a JSON object`);
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const present: Record<string, unknown> = {};
  for (const [given, value] of Object.entries(input)) {
    let key = given;
    if (!properties[key]) {
      const meant = Object.entries(PARAMETER_SYNONYMS).find(([target, synonyms]) => properties[target] && synonyms.includes(given) && !(target in input));
      if (meant) {
        key = meant[0];
        notes.push(`${given} read as ${key}`);
      }
    }
    const property = properties[key];
    if (!property) {
      const known = Object.keys(properties);
      throw new ToolArgumentError(
        `${toolName} has no parameter "${given}". It accepts: ${known.length > 0 ? known.join(", ") : "no parameters"}.`,
      );
    }
    // An explicit null means "not supplied" — but only where the schema agrees it is optional.
    if (value === undefined || value === null) {
      if (required.has(key)) throw new ToolArgumentError(`${toolName} requires ${key}`);
      continue;
    }
    if (property.type === "array") {
      const itemSchema = property.items;
      if (itemSchema.type === "object") {
        // The array as JSON text (an older edit_file shape models still send): one reading.
        let list: unknown = value;
        if (typeof list === "string") {
          try { list = JSON.parse(list); } catch { throw new ToolArgumentError(`${toolName}.${key} must be an array of objects`); }
        }
        const items = Array.isArray(list) ? list : [list];
        present[key] = items.map((item, index) => objectItem(itemSchema, item, `${toolName}.${key}[${index}]`, notes));
        continue;
      }
      // A lone item where an array is declared (`complete: 2` for `complete: [2]`): one meaning.
      const items = Array.isArray(value) ? value : [value];
      present[key] = items.map((item, index) => scalar(itemSchema.type, item, `${toolName}.${key}[${index}]`, notes));
      continue;
    }
    present[key] = scalar(property.type, value, `${toolName}.${key}`, notes);
  }

  for (const key of required) {
    if (!(key in present)) throw new ToolArgumentError(`${toolName} requires ${key}`);
  }
  return { value: present, notes };
}

/** One object in an array of objects: its fields checked like top-level ones, synonyms included. */
function objectItem(schema: ObjectItemSchema, item: unknown, label: string, notes: string[]): Record<string, unknown> {
  if (!isPlainObject(item)) throw new ToolArgumentError(`${label} must be an object`);
  const out: Record<string, unknown> = {};
  for (const [given, value] of Object.entries(item)) {
    let key = given;
    if (!schema.properties[key]) {
      const meant = Object.entries(PARAMETER_SYNONYMS).find(([target, synonyms]) => schema.properties[target] && synonyms.includes(given) && !(target in item));
      if (!meant) throw new ToolArgumentError(`${label} has no field "${given}". It accepts: ${Object.keys(schema.properties).join(", ")}.`);
      key = meant[0];
      notes.push(`${label}.${given} read as ${key}`);
    }
    if (value === undefined || value === null) continue;
    out[key] = scalar(schema.properties[key].type, value, `${label}.${key}`, notes);
  }
  for (const key of schema.required ?? []) {
    if (!(key in out)) throw new ToolArgumentError(`${label} requires ${key}`);
  }
  return out;
}

/** A declared scalar, repaired when it has one reading, refused when it has none. */
function scalar(type: ScalarType, value: unknown, label: string, notes: string[]): unknown {
  try {
    checkScalar(type, value, label);
    return value;
  } catch (error) {
    const repaired = coerceScalar(type, value);
    if (repaired === undefined) throw error;
    notes.push(`${label} was ${describe(value)}; read as ${type === "string" && typeof value === "object" ? "JSON text" : `${type === "integer" ? "an" : "a"} ${type}`}`);
    return repaired;
  }
}

/** `normalizeToolArguments` without the notes, for callers that only need the arguments. */
export function validateToolArguments(toolName: string, schema: ToolInputSchema, args: unknown): Record<string, unknown> {
  return normalizeToolArguments(toolName, schema, args).value;
}
