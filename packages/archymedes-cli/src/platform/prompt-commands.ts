/**
 * Custom slash commands: a saved prompt, invoked by name.
 *
 * A Markdown file at `.archymedes/commands/<name>.md` (shared with the project) or
 * `<config dir>/commands/<name>.md` (just for this user) becomes `/<name>`. Typing `/<name> some
 * text` sends the file's body as the turn, with `$ARGUMENTS` replaced by the text — or the text
 * appended when the file has no placeholder. An optional `description:` line in `---` front matter
 * says what it does. This is for repeatable prompts ("review this diff for X"); skills cover
 * repeatable *actions*, and AGENTS.md covers standing project facts.
 *
 * Built-in commands always win, so a file cannot silently change what `/undo` does, and a project
 * command overrides a user command of the same name, since the repository is the narrower context.
 * Files are re-read on each use, so an edit takes effect without restarting.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { settingsDirectory } from "./settings";

export type PromptCommand = {
  name: string;
  description: string;
  template: string;
  source: "project" | "user";
  path: string;
};

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_BYTES = 64 * 1024;

export function projectCommandsDirectory(root: string): string {
  return path.join(root, ".archymedes", "commands");
}

export function userCommandsDirectory(environment: Record<string, string | undefined>): string {
  return path.join(settingsDirectory(environment), "commands");
}

/** Splits optional `---` front matter from the body; only `description` is read from it. */
export function parsePromptCommand(name: string, raw: string, source: PromptCommand["source"], file: string): PromptCommand {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const body = (match ? text.slice(match[0].length) : text).trim();
  const description = match ? /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "" : "";
  return { name, description, template: body, source, path: file };
}

export function expandPromptCommand(command: PromptCommand, args: string): string {
  const trimmed = args.trim();
  if (command.template.includes("$ARGUMENTS")) return command.template.split("$ARGUMENTS").join(trimmed).trim();
  return trimmed ? `${command.template}\n\n${trimmed}` : command.template;
}

async function readDirectory(directory: string, source: PromptCommand["source"], problems: string[]): Promise<PromptCommand[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${directory}: ${(error as Error).message}`);
    return [];
  }
  const commands: PromptCommand[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    const file = path.join(directory, entry);
    if (!NAME.test(name)) {
      problems.push(`${file}: command names use lowercase letters, digits and dashes`);
      continue;
    }
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_BYTES) {
        problems.push(`${file}: larger than ${MAX_BYTES / 1024} KB`);
        continue;
      }
      const command = parsePromptCommand(name, await fs.readFile(file, "utf8"), source, file);
      if (!command.template) problems.push(`${file}: empty`);
      else commands.push(command);
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  return commands;
}

/** Every usable command by name, plus a line for each file that could not become one. */
export async function loadPromptCommands(
  root: string,
  environment: Record<string, string | undefined>,
  isBuiltIn: (name: string) => boolean,
): Promise<{ commands: Map<string, PromptCommand>; problems: string[] }> {
  const problems: string[] = [];
  const commands = new Map<string, PromptCommand>();
  const user = await readDirectory(userCommandsDirectory(environment), "user", problems);
  const project = await readDirectory(projectCommandsDirectory(root), "project", problems);
  for (const command of [...user, ...project]) {
    if (isBuiltIn(`/${command.name}`)) {
      problems.push(`${command.path}: /${command.name} is a built-in command and cannot be replaced`);
      continue;
    }
    commands.set(command.name, command);
  }
  return { commands, problems };
}

/**
 * The prompt a typed `/name args` stands for, or undefined when no custom command has that name.
 * `problems` are only returned alongside a miss, where they may explain it.
 */
export async function resolvePromptCommand(
  input: string,
  root: string,
  environment: Record<string, string | undefined>,
  isBuiltIn: (name: string) => boolean,
): Promise<{ prompt: string; command: PromptCommand } | { problems: string[]; names: string[] }> {
  const [head, ...rest] = input.slice(1).split(/(\s+)/);
  const { commands, problems } = await loadPromptCommands(root, environment, isBuiltIn);
  const command = commands.get(head);
  if (!command) return { problems, names: [...commands.keys()].map((name) => `/${name}`) };
  return { prompt: expandPromptCommand(command, rest.join("")), command };
}
