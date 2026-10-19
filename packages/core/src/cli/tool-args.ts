/**
 * Argument readers shared by the tool families (tools.ts, tools-search.ts). Each throws a message
 * the model can act on: the schema has already repaired what had one reading, so what reaches these
 * is a real mistake.
 */

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

/** An all-empty array reads as "no filter", not as a filter matching nothing. */
export function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${name} must be an array of strings`);
  const cleaned = (value as string[]).map((entry) => entry.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}
