import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFENDER_PLAYBOOK_CATALOG } from "../../packages/core/src/cli/defender-playbooks";

/**
 * Writes the defender playbooks for the Go engine, which embeds them: one Markdown file per
 * playbook, numbered in the catalog's order. The TypeScript catalog is the source; the test in
 * defender-playbooks-export.test.ts fails when the two differ, and running this again fixes it.
 */
export const PLAYBOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../internal/core/tools/playbooks");

export function playbookFiles(): Array<{ name: string; text: string }> {
  return DEFENDER_PLAYBOOK_CATALOG.map((entry, index) => ({
    name: `${String(index + 1).padStart(2, "0")}-${entry.id}.md`,
    text: `${entry.text}\n`,
  }));
}

if (import.meta.main) {
  const files = playbookFiles();
  for (const old of await fs.readdir(PLAYBOOK_DIR)) if (old.endsWith(".md")) await fs.rm(path.join(PLAYBOOK_DIR, old));
  for (const file of files) await fs.writeFile(path.join(PLAYBOOK_DIR, file.name), file.text);
  console.log(`Wrote ${files.length} playbooks to ${path.relative(process.cwd(), PLAYBOOK_DIR)}`);
}
