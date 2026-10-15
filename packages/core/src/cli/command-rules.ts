import { promises as fs } from "node:fs";
import path from "node:path";
import { tokenizeCommand } from "./command";
import { archymedesConfigDirectory } from "./memory";

/**
 * Command rules a person writes once instead of answering the same approval every day, after
 * Codex's execpolicy: a rule names a command by its leading words and says `allow` (run without
 * asking), `ask` (always ask, even in auto mode or under a standing approval) or `forbid` (never run;
 * the reason goes back to the model, so it can take the route the reason names).
 *
 * Each rule can carry examples — `match` and `not_match` — that are checked when the rules load,
 * so a rule that does not do what its author meant is reported instead of silently guarding the
 * wrong commands. A rule whose examples fail is left out and named.
 *
 * `.archymedes/rules.json` in the project and `rules.json` in the Archymedes config directory:
 *
 *   { "rules": [
 *     { "prefix": ["git", "push"], "decision": "ask", "reason": "pushes are reviewed",
 *       "match": ["git push origin main"], "not_match": ["git pull"] },
 *     { "prefix": ["rm", ["-rf", "-fr"]], "decision": "forbid", "reason": "use trash-put instead" },
 *     { "prefix": ["npm", ["test", "run"]], "decision": "allow" }
 *   ] }
 *
 * A prefix element that is a list means any one of those words. A compound command (`a && b`,
 * `a | b`, `a; b`) is judged part by part: forbid if any part is forbidden, ask if any part asks,
 * allow only when every part is allowed.
 */

export type RuleDecision = "allow" | "ask" | "forbid";

export type CommandRule = {
  prefix: Array<string | string[]>;
  decision: RuleDecision;
  reason?: string;
  /** Where the rule was written, for the messages that name it. */
  source: string;
};

export type CommandRules = { rules: CommandRule[]; problems: string[] };

export type RuleVerdict = { decision: RuleDecision; rule: CommandRule };

export const PROJECT_RULES_FILE = ".archymedes/rules.json";
export const USER_RULES_FILE = "rules.json";

/** Reads one rules file's text; every rule that is malformed or fails its own examples is named in `problems`. */
export function parseCommandRules(text: string, source: string): CommandRules {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { rules: [], problems: [`${source}: not valid JSON (${error instanceof Error ? error.message : String(error)})`] };
  }
  const list = (value as { rules?: unknown })?.rules;
  if (!Array.isArray(list)) return { rules: [], problems: [`${source}: expected {"rules": [...]}`] };
  const rules: CommandRule[] = [];
  const problems: string[] = [];
  list.forEach((entry, index) => {
    const where = `${source} rule ${index + 1}`;
    const record = (entry ?? {}) as Record<string, unknown>;
    const prefix = record.prefix;
    const valid = Array.isArray(prefix) && prefix.length > 0 && prefix.every((word) => (typeof word === "string" && word.length > 0) || (Array.isArray(word) && word.length > 0 && word.every((alt) => typeof alt === "string" && alt.length > 0)));
    if (!valid) return void problems.push(`${where}: "prefix" must be a non-empty list of words (or lists of alternative words)`);
    if (record.decision !== "allow" && record.decision !== "ask" && record.decision !== "forbid") return void problems.push(`${where}: "decision" must be allow, ask or forbid`);
    const rule: CommandRule = { prefix: prefix as CommandRule["prefix"], decision: record.decision, source, ...(typeof record.reason === "string" && record.reason.trim() ? { reason: record.reason.trim() } : {}) };
    const failures = [
      ...examples(record.match).filter((example) => !ruleMatches(rule, example)).map((example) => `should match "${example}" but does not`),
      ...examples(record.not_match).filter((example) => ruleMatches(rule, example)).map((example) => `should not match "${example}" but does`),
    ];
    if (failures.length > 0) return void problems.push(`${where} (${describePrefix(rule.prefix)}): ${failures.join("; ")} — left out`);
    rules.push(rule);
  });
  return { rules, problems };
}

/** The project's rules, then the person's own; problems from both. Missing files are no rules. */
export async function loadCommandRules(root: string, environment: Record<string, string | undefined>): Promise<CommandRules> {
  const files = [path.join(root, PROJECT_RULES_FILE), path.join(archymedesConfigDirectory(environment), USER_RULES_FILE)];
  const loaded = await Promise.all(files.map(async (file) => {
    try {
      return parseCommandRules(await fs.readFile(file, "utf8"), file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: [], problems: [] };
      return { rules: [], problems: [`${file}: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }));
  return { rules: loaded.flatMap((item) => item.rules), problems: loaded.flatMap((item) => item.problems) };
}

/** What the rules say about a command, or undefined when no rule speaks to it (the usual approval applies). */
export function judgeCommand(rules: readonly CommandRule[], command: string): RuleVerdict | undefined {
  if (rules.length === 0) return undefined;
  const parts = splitCompound(command);
  const verdicts = parts.map((part) => firstMatch(rules, part));
  const forbidden = verdicts.find((verdict) => verdict?.decision === "forbid");
  if (forbidden) return forbidden;
  const asked = verdicts.find((verdict) => verdict?.decision === "ask");
  if (asked) return asked;
  return verdicts.length > 0 && verdicts.every((verdict) => verdict?.decision === "allow") ? verdicts[0] : undefined;
}

/** The message the model gets for a forbidden command. */
export function forbiddenMessage(command: string, verdict: RuleVerdict): string {
  return `Refused by a command rule (${describePrefix(verdict.rule.prefix)}, in ${verdict.rule.source}): '${command}' is not run here.${verdict.rule.reason ? ` ${verdict.rule.reason}` : ""}`;
}

function firstMatch(rules: readonly CommandRule[], part: string): RuleVerdict | undefined {
  const rule = rules.find((candidate) => ruleMatches(candidate, part));
  return rule ? { decision: rule.decision, rule } : undefined;
}

function ruleMatches(rule: CommandRule, command: string): boolean {
  let words: string[];
  try {
    words = tokenizeCommand(command, "linux");
  } catch {
    return false;
  }
  // `FOO=1 make` is `make` with an environment.
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (words.length < rule.prefix.length) return false;
  return rule.prefix.every((expected, index) => {
    const word = index === 0 ? path.posix.basename(words[0]) : words[index];
    return Array.isArray(expected) ? expected.includes(word) : expected === word;
  });
}

/** Splits on `&&`, `||`, `;`, `|` and newlines outside quotes. */
export function splitCompound(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      current += character + command[index + 1];
      index += 1;
      continue;
    }
    const two = command.slice(index, index + 2);
    if (two === "&&" || two === "||") {
      parts.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (character === ";" || character === "|" || character === "\n") {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function examples(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((example) => (typeof example === "string" ? [example] : Array.isArray(example) && example.every((word) => typeof word === "string") ? [example.join(" ")] : []));
}

function describePrefix(prefix: CommandRule["prefix"]): string {
  return prefix.map((word) => (Array.isArray(word) ? `{${word.join("|")}}` : word)).join(" ");
}
